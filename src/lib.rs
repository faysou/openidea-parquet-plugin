use openidea_plugin::views::{View, ViewEvent, Viewport, Views};
use openidea_plugin::{Error, Invocation, Plugin, host, register_plugin};
use serde::{Deserialize, Serialize};
use serde_json::Value;

mod compare;

const VIEW: &str = "parquet";
const RESULT_ROWS: usize = 200;
const VIEW_MESSAGE_BYTES: usize = 8 << 20;

#[derive(Deserialize)]
struct Request {
    id: String,
    #[serde(default)]
    sql: String,
    #[serde(default)]
    key: String,
    #[serde(rename = "profileColumn")]
    profile_column: Option<String>,
}

#[derive(Deserialize)]
struct FileAction {
    path: String,
    text: String,
}

enum FileMode {
    Open,
    Save,
}

#[derive(Serialize)]
struct QueryResult {
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
    truncated: bool,
}

#[derive(Default)]
struct Parquet;

impl Plugin for Parquet {
    fn run_command(
        &mut self,
        id: &str,
        _: &Invocation,
        _: Option<&str>,
    ) -> Result<Option<String>, Error> {
        Err(Error::NotFound(id.into()))
    }
}

impl Views for Parquet {
    fn render(&mut self, _: &str, _: Option<Viewport>, _: &Invocation) -> Result<View, Error> {
        Ok(View::message("Open a Parquet file to use this viewer."))
    }

    fn handle(&mut self, view: &str, event: ViewEvent, ctx: &Invocation) -> Result<(), Error> {
        if view != VIEW {
            return Ok(());
        }
        let (text, action) = match event {
            ViewEvent::Message(text) => (text, None),
            ViewEvent::Field(key, value) => {
                let mode = match key.as_str() {
                    "document-file:open" => FileMode::Open,
                    "document-file:save" => FileMode::Save,
                    _ => return Ok(()),
                };
                let FileAction { path, text } =
                    serde_json::from_str(&value).map_err(|err| Error::Invalid(err.to_string()))?;
                (text, Some((mode, path)))
            }
            _ => return Ok(()),
        };
        if text.len() > 70_000 {
            return Ok(());
        }
        let request: Request =
            serde_json::from_str(&text).map_err(|err| Error::Invalid(err.to_string()))?;
        if request.id.len() > 64 {
            return Err(Error::Invalid("Invalid query ID".into()));
        }
        let _task = host::begin_task("Read Parquet with DuckDB", true);
        let result = ctx
            .editor()
            .ok_or_else(|| "Open the Parquet file again in a compatible OpenIDEA build.".to_owned())
            .and_then(|editor| run(&editor.path(), &request, action));
        let reply = match result {
            Ok(result) => serde_json::json!({ "id": request.id, "result": result }),
            Err(error) => serde_json::json!({ "id": request.id, "error": error }),
        };
        let mut reply = reply.to_string();
        if reply.len() > VIEW_MESSAGE_BYTES {
            reply = serde_json::json!({
                "id": request.id,
                "error": "The result is too large for this view. Select fewer columns or shorter values.",
            })
            .to_string();
        }
        host::post_view_message(view, &reply)
    }
}

fn run(path: &str, request: &Request, action: Option<(FileMode, String)>) -> Result<Value, String> {
    let result = match action {
        None => query(path, &request.sql)?,
        Some((FileMode::Open, target)) if let Some(column) = &request.profile_column => {
            return compare::profile(path, &target, column);
        }
        Some((FileMode::Open, target)) => compare::files(path, &target, &request.key)?,
        Some((FileMode::Save, target)) => {
            export(path, &target, &request.sql)?;
            return Ok(serde_json::json!({ "saved": true }));
        }
    };
    serde_json::to_value(result).map_err(|error| error.to_string())
}

fn export(path: &str, target: &str, sql: &str) -> Result<(), String> {
    let lower = target.to_ascii_lowercase();
    let (options, existing) = if lower.ends_with(".csv") {
        ("FORMAT CSV, HEADER", "false".to_owned())
    } else if lower.ends_with(".parquet") {
        (
            "FORMAT PARQUET",
            format!(
                "EXISTS (SELECT 1 FROM glob({target}) WHERE file = {target})",
                target = sql_string(target)
            ),
        )
    } else {
        return Err("Choose a destination ending in .csv or .parquet.".into());
    };
    if target.contains('\0') {
        return Err("Invalid export destination.".into());
    }
    let filename = target.rfind(['/', '\\']).map_or(0, |index| index + 1);
    // DuckDB writes to a sibling named tmp_<filename> before replacing the destination
    let temporary = format!("{}tmp_{}", &target[..filename], &target[filename..]);
    let setup = setup_sql(path, &[target, &temporary])?;
    let sql = sql_string(select_argument(sql)?);
    let temporary = sql_string(&temporary);
    let target = sql_string(target);
    execute(&format!(
        "{setup}
         SELECT CASE WHEN {existing}
                     THEN error('Choose a new Parquet file for export.')
                     WHEN EXISTS (SELECT 1 FROM glob({temporary}) WHERE file = {temporary})
                     THEN error('A temporary export file already exists. Choose another destination.')
                     ELSE true END;
         COPY (SELECT * FROM query({sql})) TO {target} ({options}, USE_TMP_FILE true);"
    ))?;
    Ok(())
}

fn execute(command: &str) -> Result<String, String> {
    if command
        .lines()
        .any(|line| line.trim_start().starts_with('.'))
    {
        return Err("DuckDB commands must be SQL statements.".into());
    }
    let command = format!("{command}\n");
    let output =
        host::run_process("duckdb", &cli_args(), Some(&command)).map_err(|error| match error {
            Error::Denied(_) | Error::NotFound(_) => {
                "Allow the installed DuckDB executable in Settings > Plugins > Parquet Viewer."
                    .to_owned()
            }
            other => other.to_string(),
        })?;
    if output.status != Some(0) {
        let stderr = output.stderr.trim();
        return Err(if stderr.is_empty() {
            "DuckDB stopped before returning a result.".to_owned()
        } else {
            stderr.to_owned()
        });
    }
    Ok(output.stdout)
}

fn query(path: &str, sql: &str) -> Result<QueryResult, String> {
    let setup = setup_sql(path, &[])?;
    select(&setup, select_argument(sql)?)
}

fn select(setup: &str, sql: &str) -> Result<QueryResult, String> {
    decode_result(&execute(&select_script(setup, sql, RESULT_ROWS + 1))?)
}

fn select_script(setup: &str, sql: &str, limit: usize) -> String {
    format!(
        "{setup} SELECT * FROM query({}) LIMIT {limit};",
        sql_string(sql)
    )
}

fn parquet_path(path: &str) -> bool {
    !path.contains('\0') && path.to_ascii_lowercase().ends_with(".parquet")
}

fn setup_sql(path: &str, additional_paths: &[&str]) -> Result<String, String> {
    if !parquet_path(path) {
        return Err("The query needs the path of the Parquet file open in this editor.".into());
    }
    let path = sql_string(path);
    let mut paths = path.clone();
    for target in additional_paths {
        paths.push_str(", ");
        paths.push_str(&sql_string(target));
    }
    Ok(format!(
        "SET memory_limit = '256MiB'; SET threads = 2; SET temp_directory = ''; \
         SET allowed_paths = [{paths}]; SET autoinstall_known_extensions = false; \
         SET autoload_known_extensions = false; SET enable_external_access = false; \
         SET lock_configuration = true; CREATE VIEW parquet_data AS SELECT * FROM read_parquet({path});"
    ))
}

fn select_argument(sql: &str) -> Result<&str, String> {
    if sql.trim().is_empty() || sql.len() > 64 * 1024 || sql.contains('\0') {
        return Err("Enter one SELECT query of at most 64 KiB.".into());
    }
    Ok(sql)
}

fn cli_args() -> Vec<String> {
    ["-no-init", "-batch", "-bail", "-json"]
        .into_iter()
        .map(str::to_owned)
        .collect()
}

fn sql_string(text: &str) -> String {
    let mut literal = String::from("E'");
    for character in text.chars() {
        match character {
            '\'' => literal.push_str("''"),
            '\\' => literal.push_str("\\\\"),
            '\n' => literal.push_str("\\n"),
            '\r' => literal.push_str("\\r"),
            character => literal.push(character),
        }
    }
    literal.push('\'');
    literal
}

fn decode_result(stdout: &str) -> Result<QueryResult, String> {
    let records: Vec<serde_json::Map<String, Value>> = serde_json::from_str(stdout)
        .or_else(|_| serde_json::from_str(&quote_nonfinite(stdout)))
        .map_err(|_| {
            "DuckDB returned an incomplete result. Select fewer columns or shorter values."
                .to_owned()
        })?;
    let columns: Vec<String> = records
        .first()
        .map(|row| row.keys().cloned().collect())
        .unwrap_or_default();
    let rows = records
        .iter()
        .take(RESULT_ROWS)
        .map(|row| {
            columns
                .iter()
                .map(|name| match row.get(name) {
                    Some(Value::String(text)) => Some(text.clone()),
                    Some(Value::Null) | None => None,
                    Some(value) => Some(value.to_string()),
                })
                .collect()
        })
        .collect();
    Ok(QueryResult {
        columns,
        rows,
        truncated: records.len() > RESULT_ROWS,
    })
}

fn quote_nonfinite(stdout: &str) -> String {
    let mut json = String::with_capacity(stdout.len());
    let mut last_end = 0;
    let mut in_string = false;
    let mut escaped = false;
    for (index, character) in stdout.char_indices() {
        if index < last_end {
            continue;
        }
        match (in_string, escaped, character) {
            (true, true, _) => escaped = false,
            (true, false, '\\') => escaped = true,
            (_, false, '"') => in_string = !in_string,
            (false, _, 'N' | 'I' | '-') => {
                let Some(token) = nonfinite_value(stdout, index) else {
                    continue;
                };
                json.push_str(&stdout[last_end..index]);
                json.push('"');
                json.push_str(token);
                json.push('"');
                last_end = index + token.len();
            }
            _ => {}
        }
    }
    json.push_str(&stdout[last_end..]);
    json
}

fn nonfinite_value(stdout: &str, index: usize) -> Option<&'static str> {
    let token = ["NaN", "Infinity", "-Infinity"]
        .into_iter()
        .find(|token| stdout[index..].starts_with(token))?;
    let end = index + token.len();
    (stdout[..index].trim_end().ends_with([':', '[', ','])
        && stdout[end..].trim_start().starts_with([',', ']', '}']))
    .then_some(token)
}

register_plugin!(Parquet, views);

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{self, Write};
    use std::process::{Command, Output, Stdio};

    pub(super) fn run_cli(script: &str) -> io::Result<Output> {
        let mut child = Command::new("duckdb")
            .args(cli_args())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        writeln!(child.stdin.take().unwrap(), "{script}")?;
        child.wait_with_output()
    }

    #[test]
    fn preserves_order_nulls_and_large_integers() {
        let decoded =
            decode_result(r#"[{"z":9007199254740993,"a":null,"tags":[9007199254740993]}]"#)
                .unwrap();
        assert_eq!(decoded.columns, ["z", "a", "tags"]);
        assert_eq!(
            decoded.rows,
            [vec![
                Some("9007199254740993".into()),
                None,
                Some("[9007199254740993]".into())
            ]]
        );
    }

    #[test]
    fn decodes_nonfinite_values_in_columns_and_nested_values() {
        let decoded = decode_result(
            r#"[{"n":NaN,"p":Infinity,"m":-Infinity,"nested":{"x":[NaN,Infinity]},"text":"quoted \"Infinity\""}]"#,
        )
        .unwrap();
        assert_eq!(decoded.columns, ["n", "p", "m", "nested", "text"]);
        assert_eq!(
            decoded.rows,
            [vec![
                Some("NaN".into()),
                Some("Infinity".into()),
                Some("-Infinity".into()),
                Some(r#"{"x":["NaN","Infinity"]}"#.into()),
                Some("quoted \"Infinity\"".into()),
            ]]
        );
    }

    #[test]
    fn uses_the_open_file_and_accepts_only_one_select() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("test/fixtures/synthetic-trades.parquet");
        let setup = setup_sql(path.to_str().unwrap(), &[]).unwrap();
        let run = |sql| {
            run_cli(&select_script(
                &setup,
                select_argument(sql).unwrap(),
                RESULT_ROWS + 1,
            ))
        };
        let result = match run(
            "SELECT event, count(*) AS n FROM parquet_data GROUP BY event ORDER BY event",
        ) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            result => result.unwrap(),
        };
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let decoded = decode_result(&String::from_utf8(result.stdout).unwrap()).unwrap();
        assert_eq!(decoded.columns, ["event", "n"]);
        assert_eq!(
            decoded.rows,
            [
                vec![Some("quote".into()), Some("79".into())],
                vec![Some("snapshot".into()), Some("78".into())],
                vec![Some("trade".into()), Some("78".into())],
            ],
        );
        assert!(!decoded.truncated);

        let multi_statement = run("SELECT 1; SELECT 2").unwrap();
        assert!(!multi_statement.status.success());
        let other_file = run("SELECT * FROM read_parquet('/unrelated.parquet')").unwrap();
        assert!(String::from_utf8_lossy(&other_file.stderr).contains("disabled by configuration"));

        let dots = "SELECT 'first\n .print text\r\n.last \\' AS value";
        let script = select_script(&setup, dots, 1);
        assert!(!script.contains(['\r', '\n']));
        let decoded =
            decode_result(&String::from_utf8(run(dots).unwrap().stdout).unwrap()).unwrap();
        assert_eq!(
            decoded.rows,
            [vec![Some("first\n .print text\r\n.last \\".into())]]
        );

        let wide = format!("SELECT length('{}') AS n", "a".repeat(6000));
        assert!(select_script(&setup, &wide, 1).len() > 4096);
        let decoded =
            decode_result(&String::from_utf8(run(&wide).unwrap().stdout).unwrap()).unwrap();
        assert_eq!(decoded.rows, [vec![Some("6000".into())]]);
    }
}
