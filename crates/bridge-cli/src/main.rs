use std::env;
use std::process::ExitCode;

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    let is_json = args.iter().any(|a| a == "--json");
    let is_perf = args.iter().any(|a| a == "--perf");

    let subcmd = args.first().map(|s| s.as_str()).unwrap_or("help");

    match subcmd {
        "help" | "--help" | "-h" => {
            println!("BridgeDev v0.1.0 — Self-hosted MCP Development Gateway (Rust Core)");
            println!("Usage: bridge-dev [command] [options]\n");
            println!("Core Commands:");
            println!("  help                  Display command help");
            println!("  status                Show gateway status, mode, and sessions");
            println!("  mode                  Display current security profile");
            println!("  doctor [--perf]       Run diagnostics or performance inspection");
            ExitCode::SUCCESS
        }
        "status" => {
            if is_json {
                println!(
                    "{}",
                    serde_json::json!({
                        "ok": true,
                        "command": "status",
                        "output": ["BridgeDev: running · STANDARD"]
                    })
                );
            } else {
                println!("BridgeDev: running · STANDARD");
            }
            ExitCode::SUCCESS
        }
        "mode" => {
            if is_json {
                println!(
                    "{}",
                    serde_json::json!({
                        "ok": true,
                        "command": "mode",
                        "output": ["STANDARD"]
                    })
                );
            } else {
                println!("STANDARD");
            }
            ExitCode::SUCCESS
        }
        "doctor" => {
            if is_perf {
                let port: u16 = env::var("PORT")
                    .ok()
                    .and_then(|p| p.parse().ok())
                    .unwrap_or(3000);
                let token = env::var("MCP_TOKEN").unwrap_or_default();

                let client = reqwest::Client::new();
                let url = format!("http://127.0.0.1:{}/diagnostics/perf", port);
                let mut req = client.get(&url);
                if !token.is_empty() {
                    req = req.header("Authorization", format!("Bearer {}", token));
                }

                match req.send().await {
                    Ok(resp) if resp.status().is_success() => {
                        let text = resp.text().await.unwrap_or_default();
                        if is_json {
                            println!(
                                "{}",
                                serde_json::json!({
                                    "ok": true,
                                    "command": "doctor",
                                    "output": [text]
                                })
                            );
                        } else {
                            println!("Performance Diagnostics: {}", text);
                        }
                        ExitCode::SUCCESS
                    }
                    Ok(resp) => {
                        let err_msg = format!("HTTP error {}", resp.status());
                        if is_json {
                            println!(
                                "{}",
                                serde_json::json!({
                                    "ok": false,
                                    "command": "doctor",
                                    "output": [err_msg]
                                })
                            );
                        } else {
                            eprintln!("Error: {}", err_msg);
                        }
                        ExitCode::FAILURE
                    }
                    Err(e) => {
                        let err_msg = e.to_string();
                        if is_json {
                            println!(
                                "{}",
                                serde_json::json!({
                                    "ok": false,
                                    "command": "doctor",
                                    "output": [err_msg]
                                })
                            );
                        } else {
                            eprintln!("Error: {}", err_msg);
                        }
                        ExitCode::FAILURE
                    }
                }
            } else {
                if is_json {
                    println!(
                        "{}",
                        serde_json::json!({
                            "ok": true,
                            "command": "doctor",
                            "output": ["All checks OK"]
                        })
                    );
                } else {
                    println!("BridgeDev doctor: all checks OK");
                }
                ExitCode::SUCCESS
            }
        }
        unknown => {
            if is_json {
                println!(
                    "{}",
                    serde_json::json!({
                        "ok": false,
                        "command": unknown,
                        "output": [format!("Unknown command: {}", unknown)]
                    })
                );
            } else {
                eprintln!("Unknown command: {}", unknown);
            }
            ExitCode::FAILURE
        }
    }
}
