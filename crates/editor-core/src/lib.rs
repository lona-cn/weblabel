//! CPU-only editor state, commands, and reversible document history.

mod commands;
mod editor;
mod history;
mod selection;
mod tools;

pub use annotation_domain::{ApiError, DomainError, EditorCommand, EditorDelta};
pub use editor::Editor;
pub use geometry::Viewport;
pub use selection::{LocalFlags, Selection};
pub use tools::{PointerInput, PointerPhase, Preview, Tool};
