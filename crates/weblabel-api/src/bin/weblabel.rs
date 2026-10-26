#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    weblabel_api::cli::run(std::env::args_os().skip(1)).await
}
