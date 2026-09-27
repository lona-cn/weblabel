use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Split {
    Train,
    Val,
    Test,
}

impl Split {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Train => "train",
            Self::Val => "val",
            Self::Test => "test",
        }
    }
}

/// Deterministically assigns complete source groups to the requested proportions.
/// Ties are stable because both group keys and splits use canonical ordering.
pub fn grouped(
    seed: &str,
    groups: impl IntoIterator<Item = String>,
    ratios: [u32; 3],
) -> Result<BTreeMap<String, Split>, &'static str> {
    let total = ratios.iter().map(|v| u64::from(*v)).sum::<u64>();
    if total == 0 {
        return Err("SPLIT_RATIOS_INVALID");
    }
    let mut result = BTreeMap::new();
    for group in groups {
        let mut hash = Sha256::new();
        hash.update(seed.as_bytes());
        hash.update([0]);
        hash.update(group.as_bytes());
        let digest = hash.finalize();
        let value =
            u64::from_be_bytes(digest[..8].try_into().expect("fixed SHA-256 prefix")) % total;
        let train = u64::from(ratios[0]);
        let val = u64::from(ratios[1]);
        let split = if value < train {
            Split::Train
        } else if value < train + val {
            Split::Val
        } else {
            Split::Test
        };
        result.insert(group, split);
    }
    Ok(result)
}

/// Checks user-assigned splits against immutable source grouping.
pub fn validate_explicit_group_splits(
    assignments: impl IntoIterator<Item = (String, Split)>,
) -> Result<(), &'static str> {
    let mut splits = BTreeMap::new();
    for (group, split) in assignments {
        if splits
            .insert(group, split)
            .is_some_and(|previous| previous != split)
        {
            return Err("SOURCE_GROUP_SPLIT");
        }
    }
    Ok(())
}
