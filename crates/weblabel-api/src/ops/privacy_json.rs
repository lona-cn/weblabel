//! The old scrubber uses JSON.parse/Object.entries/JSON.stringify, not a map
//! canonicalizer. Preserve insertion order, duplicate-key replacement, array-index
//! enumeration, binary64 numbers and lone UTF-16 surrogates. Collision-free TEXT
//! is never serialized; this codec is only for inspection/mutable diagnostics.
use crate::{cli::Error, server::release::failure};
#[derive(Clone)]
pub(super) enum Json {
    Null,
    Bool(bool),
    Number(f64),
    String(Vec<u16>),
    Array(Vec<Json>),
    Object(Vec<(Vec<u16>, Json)>),
}
struct Parser<'a> {
    text: &'a str,
    offset: usize,
}
impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.text.as_bytes().get(self.offset).copied()
    }
    fn space(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\n' | b'\r' | b'\t')) {
            self.offset += 1;
        }
    }
    fn byte(&mut self, byte: u8) -> Result<(), ()> {
        self.space();
        if self.peek() != Some(byte) {
            return Err(());
        }
        self.offset += 1;
        Ok(())
    }
    fn string(&mut self) -> Result<Vec<u16>, ()> {
        self.byte(b'"')?;
        let mut value = Vec::new();
        loop {
            match self.peek().ok_or(())? {
                b'"' => {
                    self.offset += 1;
                    return Ok(value);
                }
                b'\\' => {
                    self.offset += 1;
                    let escaped = self.peek().ok_or(())?;
                    self.offset += 1;
                    let unit = match escaped {
                        b'"' => 34,
                        b'\\' => 92,
                        b'/' => 47,
                        b'b' => 8,
                        b'f' => 12,
                        b'n' => 10,
                        b'r' => 13,
                        b't' => 9,
                        b'u' => {
                            let mut n = 0u16;
                            for _ in 0..4 {
                                let b = self.peek().ok_or(())?;
                                let digit = (b as char).to_digit(16).ok_or(())?;
                                n = (n << 4) | digit as u16;
                                self.offset += 1;
                            }
                            n
                        }
                        _ => return Err(()),
                    };
                    value.push(unit);
                }
                0..=31 => return Err(()),
                _ => {
                    let ch = self.text[self.offset..].chars().next().ok_or(())?;
                    self.offset += ch.len_utf8();
                    value.extend_from_slice(ch.encode_utf16(&mut [0u16; 2]));
                }
            }
        }
    }
    fn number(&mut self) -> Result<Json, ()> {
        let start = self.offset;
        if self.peek() == Some(b'-') {
            self.offset += 1;
        }
        match self.peek() {
            Some(b'0') => self.offset += 1,
            Some(b'1'..=b'9') => {
                self.offset += 1;
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.offset += 1;
                }
            }
            _ => return Err(()),
        }
        if self.peek() == Some(b'.') {
            self.offset += 1;
            let first = self.offset;
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.offset += 1;
            }
            if self.offset == first {
                return Err(());
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.offset += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.offset += 1;
            }
            let first = self.offset;
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.offset += 1;
            }
            if self.offset == first {
                return Err(());
            }
        }
        Ok(Json::Number(
            self.text[start..self.offset].parse().map_err(|_| ())?,
        ))
    }
    fn value(&mut self) -> Result<Json, ()> {
        self.space();
        match self.peek().ok_or(())? {
            b'"' => self.string().map(Json::String),
            b'[' => {
                self.offset += 1;
                self.space();
                let mut items = Vec::new();
                if self.peek() == Some(b']') {
                    self.offset += 1;
                    return Ok(Json::Array(items));
                }
                loop {
                    items.push(self.value()?);
                    self.space();
                    if self.peek() == Some(b']') {
                        self.offset += 1;
                        break;
                    }
                    self.byte(b',')?;
                }
                Ok(Json::Array(items))
            }
            b'{' => {
                self.offset += 1;
                self.space();
                let mut items: Vec<(Vec<u16>, Json)> = Vec::new();
                if self.peek() == Some(b'}') {
                    self.offset += 1;
                    return Ok(Json::Object(items));
                }
                loop {
                    let key = self.string()?;
                    self.byte(b':')?;
                    let value = self.value()?;
                    if let Some(old) = items.iter_mut().find(|(k, _)| *k == key) {
                        old.1 = value;
                    } else {
                        items.push((key, value));
                    }
                    self.space();
                    if self.peek() == Some(b'}') {
                        self.offset += 1;
                        break;
                    }
                    self.byte(b',')?;
                }
                items.sort_by_key(|(key, _)| index_key(key).map_or((1, 0), |index| (0, index)));
                Ok(Json::Object(items))
            }
            b't' | b'f' | b'n' => {
                for (token, value) in [
                    ("true", Json::Bool(true)),
                    ("false", Json::Bool(false)),
                    ("null", Json::Null),
                ] {
                    if self.text[self.offset..].starts_with(token) {
                        self.offset += token.len();
                        return Ok(value);
                    }
                }
                Err(())
            }
            _ => self.number(),
        }
    }
}
fn index_key(key: &[u16]) -> Option<u32> {
    if key.is_empty() || (key.len() > 1 && key[0] == b'0' as u16) {
        return None;
    }
    let mut value = 0u32;
    for unit in key {
        if !(48..=57).contains(unit) {
            return None;
        }
        value = value.checked_mul(10)?.checked_add((*unit - 48) as u32)?;
    }
    (value != u32::MAX).then_some(value)
}
pub(super) fn parse(text: &str) -> Result<Json, Error> {
    let mut parser = Parser { text, offset: 0 };
    let value = parser
        .value()
        .map_err(|_| failure("database_json_invalid"))?;
    parser.space();
    if parser.offset != text.len() {
        return Err(failure("database_json_invalid").into());
    }
    Ok(value)
}
fn string(value: &[u16], out: &mut String) {
    use std::fmt::Write;
    out.push('"');
    let mut units = value.iter().copied().peekable();
    while let Some(unit) = units.next() {
        match unit {
            34 => out.push_str("\\\""),
            92 => out.push_str("\\\\"),
            8 => out.push_str("\\b"),
            12 => out.push_str("\\f"),
            10 => out.push_str("\\n"),
            13 => out.push_str("\\r"),
            9 => out.push_str("\\t"),
            0..=31 => {
                write!(out, "\\u{unit:04x}").unwrap();
            }
            0xd800..=0xdbff
                if units
                    .peek()
                    .is_some_and(|next| (0xdc00..=0xdfff).contains(next)) =>
            {
                let low = units.next().unwrap();
                out.push(
                    char::from_u32(
                        0x10000 + (((unit - 0xd800) as u32) << 10) + (low - 0xdc00) as u32,
                    )
                    .unwrap(),
                );
            }
            0xd800..=0xdfff => {
                write!(out, "\\u{unit:04x}").unwrap();
            }
            _ => out.push(char::from_u32(unit as u32).unwrap()),
        }
    }
    out.push('"');
}
fn number(value: f64, out: &mut String) {
    if !value.is_finite() {
        out.push_str("null");
        return;
    }
    if value == 0.0 {
        out.push('0');
        return;
    }
    if value < 0.0 {
        out.push('-');
    }
    let raw = value.abs().to_string();
    let (mantissa, exponent) = raw
        .split_once(['e', 'E'])
        .map_or((raw.as_str(), 0), |(m, e)| (m, e.parse::<i32>().unwrap()));
    let mut position = mantissa.find('.').unwrap_or(mantissa.len()) as i32 + exponent;
    let mut digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let leading = digits.bytes().take_while(|b| *b == b'0').count();
    position -= leading as i32;
    digits.drain(..leading);
    while digits.len() > 1 && digits.ends_with('0') {
        digits.pop();
    }
    let power = position - 1;
    if !(-6..21).contains(&power) {
        out.push(digits.as_bytes()[0] as char);
        if digits.len() > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('e');
        if power >= 0 {
            out.push('+');
        }
        out.push_str(&power.to_string());
    } else if position <= 0 {
        out.push_str("0.");
        for _ in 0..-position {
            out.push('0');
        }
        out.push_str(&digits);
    } else if position as usize >= digits.len() {
        out.push_str(&digits);
        for _ in digits.len()..position as usize {
            out.push('0');
        }
    } else {
        out.push_str(&digits[..position as usize]);
        out.push('.');
        out.push_str(&digits[position as usize..]);
    }
}
pub(super) fn encode(value: &Json) -> String {
    fn write(value: &Json, out: &mut String) {
        match value {
            Json::Null => out.push_str("null"),
            Json::Bool(value) => out.push_str(if *value { "true" } else { "false" }),
            Json::Number(value) => number(*value, out),
            Json::String(value) => string(value, out),
            Json::Array(values) => {
                out.push('[');
                for (i, value) in values.iter().enumerate() {
                    if i != 0 {
                        out.push(',');
                    }
                    write(value, out);
                }
                out.push(']');
            }
            Json::Object(values) => {
                out.push('{');
                for (i, (key, value)) in values.iter().enumerate() {
                    if i != 0 {
                        out.push(',');
                    }
                    string(key, out);
                    out.push(':');
                    write(value, out);
                }
                out.push('}');
            }
        }
    }
    let mut out = String::new();
    write(value, &mut out);
    out
}
