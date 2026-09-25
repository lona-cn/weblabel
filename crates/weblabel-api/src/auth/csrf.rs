use sha2::{Digest, Sha256};

pub(crate) fn hash(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

pub(crate) fn constant_time_eq(left: &str, right: &str) -> bool {
    let max = left.len().max(right.len());
    let mut difference = left.len() ^ right.len();
    for index in 0..max {
        difference |= left.as_bytes().get(index).copied().unwrap_or(0) as usize
            ^ right.as_bytes().get(index).copied().unwrap_or(0) as usize;
    }
    difference == 0
}
