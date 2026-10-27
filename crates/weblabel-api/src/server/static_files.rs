use super::release::{self, Release};
use axum::{
    body::{Body, Bytes, HttpBody},
    extract::Request,
    http::{header, Method, StatusCode},
    middleware,
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use std::{
    io,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
};
use tokio::io::{AsyncRead, ReadBuf};

struct FileBody {
    file: tokio::fs::File,
    remaining: u64,
    buffer: Vec<u8>,
    _permit: tokio::sync::OwnedSemaphorePermit,
}
impl HttpBody for FileBody {
    type Data = Bytes;
    type Error = io::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<http_body::Frame<Bytes>, io::Error>>> {
        if self.remaining == 0 {
            return Poll::Ready(None);
        }
        let this = &mut *self;
        if this.buffer.is_empty() {
            this.buffer
                .resize(this.remaining.min(64 * 1024) as usize, 0);
        }
        let mut read = ReadBuf::new(&mut this.buffer);
        match Pin::new(&mut this.file).poll_read(cx, &mut read) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Err(error)) => {
                this.remaining = 0;
                Poll::Ready(Some(Err(error)))
            }
            Poll::Ready(Ok(())) => {
                let count = read.filled().len();
                if count == 0 {
                    this.remaining = 0;
                    return Poll::Ready(Some(Err(io::Error::from(io::ErrorKind::UnexpectedEof))));
                }
                this.remaining -= count as u64;
                let mut bytes = std::mem::take(&mut this.buffer);
                bytes.truncate(count);
                Poll::Ready(Some(Ok(http_body::Frame::data(Bytes::from(bytes)))))
            }
        }
    }
    fn size_hint(&self) -> http_body::SizeHint {
        http_body::SizeHint::with_exact(self.remaining)
    }
    fn is_end_stream(&self) -> bool {
        self.remaining == 0
    }
}

fn decoded_path(path: &str) -> Option<String> {
    if path.len() > 4096 {
        return None;
    }
    let mut bytes = Vec::with_capacity(path.len());
    let raw = path.as_bytes();
    let mut index = 0;
    while index < raw.len() {
        if raw[index] == b'%' {
            let hi = (*raw.get(index + 1)? as char).to_digit(16)?;
            let lo = (*raw.get(index + 2)? as char).to_digit(16)?;
            let byte = (hi * 16 + lo) as u8;
            if matches!(byte, b'/' | b'\\' | b'%' | b'\0') {
                return None;
            }
            bytes.push(byte);
            index += 3;
        } else {
            bytes.push(raw[index]);
            index += 1;
        }
    }
    let decoded = String::from_utf8(bytes).ok()?;
    if decoded == "/" || release::valid_relative(decoded.strip_prefix('/')?) {
        Some(decoded)
    } else {
        None
    }
}

pub fn router(release: Release, maintenance: bool) -> io::Result<Router> {
    let release = Arc::new(release);
    let mut router = Router::new();
    let reads = Arc::new(tokio::sync::Semaphore::new(4));
    for (path, entry) in &release.web {
        if ["/api", "/internal", "/health", "/ready"]
            .iter()
            .any(|reserved| path.as_str() == *reserved || path.starts_with(&format!("{reserved}/")))
            || path.contains(['{', '}'])
        {
            return Err(release::failure("RELEASE_ROUTE_COLLISION"));
        }
        let extension = path.rsplit('.').next().unwrap_or("");
        if maintenance
            && path != "/index.html"
            && !matches!(
                extension,
                "js" | "mjs" | "css" | "wasm" | "woff" | "woff2" | "ttf" | "ico"
            )
        {
            continue;
        }
        let paths = if path == "/index.html" {
            vec!["/".to_owned(), path.clone()]
        } else {
            vec![path.clone()]
        };
        for route in paths {
            let source = release.clone();
            let entry = entry.clone();
            let expected = route.clone();
            let reads = reads.clone();
            router = router.route(
                &route,
                get(move |request: Request| {
                    let source = source.clone();
                    let entry = entry.clone();
                    let expected = expected.clone();
                    let reads = reads.clone();
                    async move {
                        if decoded_path(request.uri().path()).as_deref() != Some(expected.as_str())
                        {
                            return StatusCode::BAD_REQUEST.into_response();
                        }
                        let permit = match reads.acquire_owned().await {
                            Ok(permit) => permit,
                            Err(_) => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
                        };
                        let opened = tokio::task::spawn_blocking(move || {
                            source.open_web(&entry).map(|file| (file, entry, permit))
                        })
                        .await;
                        match opened {
                            Ok(Ok((file, entry, permit))) => {
                                let body = if request.method() == Method::HEAD {
                                    Body::empty()
                                } else {
                                    Body::new(FileBody {
                                        file: tokio::fs::File::from_std(file),
                                        remaining: entry.size,
                                        buffer: Vec::new(),
                                        _permit: permit,
                                    })
                                };
                                let mut response = Response::new(body);
                                response.headers_mut().insert(
                                    header::CONTENT_TYPE,
                                    header::HeaderValue::from_static(release::mime(&entry.path)),
                                );
                                response.headers_mut().insert(
                                    header::CONTENT_LENGTH,
                                    header::HeaderValue::from(entry.size),
                                );
                                response.headers_mut().insert(
                                    header::CACHE_CONTROL,
                                    header::HeaderValue::from_static("no-cache"),
                                );
                                response
                            }
                            _ => StatusCode::SERVICE_UNAVAILABLE.into_response(),
                        }
                    }
                }),
            );
        }
    }
    Ok(router)
}

pub async fn security_headers(request: Request, next: middleware::Next) -> Response {
    let mut response = next.run(request).await;
    for (name, value) in [
        ("content-security-policy", "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self'; img-src 'self' blob: data:; font-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"),
        ("x-content-type-options", "nosniff"), ("x-frame-options", "DENY"), ("referrer-policy", "no-referrer"),
    ] { response.headers_mut().insert(name, header::HeaderValue::from_static(value)); }
    response
}
