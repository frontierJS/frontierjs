// desktop/shell/src/go.rs — `workbench-desktop --go <path>`, and the script that
// tells the page to open a path.
//
// A second launch hands its argv to the running window (main.rs), so the path is
// another program's text on its way into `eval`. It is refused unless it is a
// path the page itself would take (routes/_module.mesa: `/`, never `//`), and it
// enters the script only as a JSON string literal, so no quote in it can end
// the string.

/// The path after `--go`, if the arguments carry one. `argv[0]` is the program.
pub fn arg(argv: &[String]) -> Option<&str> {
    let at = argv.iter().skip(1).position(|a| a == "--go")? + 1;
    argv.get(at + 1).map(String::as_str)
}

/// The script that opens `path` through the page's `traygoto` listener, or
/// `None` for a path the page would refuse.
pub fn script(path: &str) -> Option<String> {
    if !path.starts_with('/') || path.starts_with("//") {
        return None;
    }
    let detail = serde_json::to_string(path).ok()?;
    Some(format!("window.dispatchEvent(new CustomEvent('traygoto', {{ detail: {detail} }}))"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(args: &[&str]) -> Vec<String> {
        std::iter::once("workbench-desktop").chain(args.iter().copied()).map(String::from).collect()
    }

    #[test]
    fn reads_the_path_after_go() {
        assert_eq!(arg(&argv(&["--go", "/capture/"])), Some("/capture/"));
        assert_eq!(arg(&argv(&["--verbose", "--go", "/atlas/decide/"])), Some("/atlas/decide/"));
    }

    #[test]
    fn no_go_is_none() {
        assert_eq!(arg(&argv(&[])), None);
        assert_eq!(arg(&argv(&["/capture/"])), None);
        assert_eq!(arg(&argv(&["--go"])), None);
    }

    #[test]
    fn the_program_name_is_never_the_flag() {
        let args = vec!["--go".to_string(), "/capture/".to_string()];
        assert_eq!(arg(&args), None);
    }

    #[test]
    fn a_path_becomes_a_traygoto_event() {
        assert_eq!(
            script("/capture/").as_deref(),
            Some(r#"window.dispatchEvent(new CustomEvent('traygoto', { detail: "/capture/" }))"#)
        );
    }

    #[test]
    fn refuses_what_the_page_refuses() {
        assert_eq!(script("capture/"), None);
        assert_eq!(script(""), None);
        assert_eq!(script("//evil.example/"), None);
        assert_eq!(script("https://evil.example/"), None);
        assert_eq!(script("javascript:alert(1)"), None);
    }

    #[test]
    fn quotes_cannot_end_the_string() {
        let s = script(r#"/x"}));alert(1);//'\"#).unwrap();
        assert_eq!(
            s,
            r#"window.dispatchEvent(new CustomEvent('traygoto', { detail: "/x\"}));alert(1);//'\\" }))"#
        );
        for path in ["/a\nb", "/a\u{2028}b", "/</script>", "/${x}`"] {
            let s = script(path).unwrap();
            let literal = s.strip_prefix("window.dispatchEvent(new CustomEvent('traygoto', { detail: ").unwrap();
            let literal = literal.strip_suffix(" }))").unwrap();
            assert_eq!(serde_json::from_str::<String>(literal).unwrap(), path);
        }
    }
}
