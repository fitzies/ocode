use std::env;

use tauri::{WebviewUrl, WebviewWindowBuilder};

const COMPILED_FORGE_URL: Option<&str> = option_env!("OCODE_FORGE_URL");

fn parse_forge_url(value: &str) -> Option<tauri::Url> {
    let url = tauri::Url::parse(value.trim()).ok()?;
    let host = url.host_str()?;
    let is_tailnet_https_origin = url.scheme() == "https"
        && host.ends_with(".ts.net")
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(url.port(), None | Some(443))
        && matches!(url.path(), "" | "/")
        && url.query().is_none()
        && url.fragment().is_none();

    is_tailnet_https_origin.then_some(url)
}

fn configured_forge_url() -> Option<tauri::Url> {
    let configured = match env::var("OCODE_FORGE_URL") {
        Ok(value) => Some(value),
        Err(env::VarError::NotPresent) => COMPILED_FORGE_URL.map(str::to_owned),
        Err(env::VarError::NotUnicode(_)) => None,
    }?;

    parse_forge_url(&configured)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let url = configured_forge_url()
                .map(WebviewUrl::External)
                .unwrap_or_else(|| WebviewUrl::App("index.html".into()));

            WebviewWindowBuilder::new(app, "main", url)
                .title("ocode")
                .inner_size(1280.0, 800.0)
                .min_inner_size(800.0, 600.0)
                .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running ocode desktop");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_tailnet_https_origins() {
        let url = parse_forge_url(" https://forge.example.ts.net ").unwrap();
        assert_eq!(url.as_str(), "https://forge.example.ts.net/");
        assert!(parse_forge_url("https://forge.example.ts.net:443").is_some());
    }

    #[test]
    fn rejects_urls_outside_the_tailnet_origin_boundary() {
        for value in [
            "http://forge.example.ts.net",
            "https://example.com",
            "https://example.ts.net.evil.test",
            "https://user:password@forge.example.ts.net",
            "https://forge.example.ts.net/path",
            "https://forge.example.ts.net?query=value",
            "https://forge.example.ts.net/#fragment",
            "https://forge.example.ts.net:8443",
            "file:///tmp/ocode",
            "https:///missing-host",
            "not a URL",
            "",
        ] {
            assert!(parse_forge_url(value).is_none(), "accepted {value}");
        }
    }
}
