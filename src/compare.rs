use crate::{QueryResult, execute, parquet_path, select, select_script, setup_sql, sql_string};
use serde::Serialize;
use serde_json::{Value, json};

pub(super) fn files(source: &str, target: &str, key: &str) -> Result<QueryResult, String> {
    let setup = setup_files(source, target)?;
    let schema_diff = select(
        &setup,
        "WITH l AS (SELECT column_name, column_type, row_number() OVER () AS position
                    FROM (DESCRIBE SELECT * FROM parquet_data)),
              r AS (SELECT column_name, column_type, row_number() OVER () AS position
                    FROM (DESCRIBE SELECT * FROM parquet_target))
         SELECT column_name AS \"Column\", l.column_type AS \"Open file\",
                r.column_type AS \"Selected file\", l.position AS \"Open position\",
                r.position AS \"Selected position\"
         FROM l FULL JOIN r USING (column_name)
         WHERE l.column_type IS DISTINCT FROM r.column_type
            OR l.position IS DISTINCT FROM r.position
         ORDER BY coalesce(l.position, r.position), column_name",
    )?;
    if key.is_empty() || !schema_diff.rows.is_empty() {
        return Ok(schema_diff);
    }

    let key = identifier(key);
    select(
        &setup,
        &format!(
            "WITH checks AS (
                SELECT EXISTS(SELECT 1 FROM parquet_data GROUP BY {key}
                             HAVING {key} IS NULL OR count(*) > 1) AS bad_source,
                       EXISTS(SELECT 1 FROM parquet_target GROUP BY {key}
                             HAVING {key} IS NULL OR count(*) > 1) AS bad_target
             ), delta AS (
                SELECT CASE WHEN l.{key} IS NULL THEN 'Added'
                            WHEN r.{key} IS NULL THEN 'Removed'
                            ELSE 'Changed' END AS change,
                       coalesce(l.{key}, r.{key}) AS row_key,
                       CASE WHEN l.{key} IS NOT NULL THEN to_json(l) END AS before,
                       CASE WHEN r.{key} IS NOT NULL THEN to_json(r) END AS after
                FROM parquet_data l FULL JOIN parquet_target r ON l.{key} = r.{key}
                WHERE l.{key} IS NULL OR r.{key} IS NULL OR l IS DISTINCT FROM r
             ), result AS (
                SELECT change, row_key, before, after, count(*) OVER (PARTITION BY change) AS total,
                       row_number() OVER (PARTITION BY change ORDER BY row_key) AS rank
                FROM delta
             )
             SELECT change AS \"Change\", row_key AS \"Key\", before AS \"Open file\",
                    after AS \"Selected file\", total AS \"Total by change\"
             FROM checks LEFT JOIN result ON true
             WHERE CASE WHEN bad_source OR bad_target
                        THEN error('The key must be unique and non-null in both files.')
                        ELSE change IS NOT NULL END
             ORDER BY rank, change"
        ),
    )
}

pub(super) fn profile(source: &str, target: &str, column: &str) -> Result<Value, String> {
    let setup = setup_files(source, target)?;
    let name = sql_string(column);
    let types = select(
        &setup,
        &format!(
            "SELECT (SELECT column_type FROM (DESCRIBE parquet_data)
                     WHERE column_name = {name}) AS source,
                    (SELECT column_type FROM (DESCRIBE parquet_target)
                     WHERE column_name = {name}) AS target"
        ),
    )?;
    let [Some(source_type), target_type] = types.rows.first().map(Vec::as_slice).unwrap_or(&[])
    else {
        return Err("The column does not exist in the open file.".into());
    };

    let kind = match target_type.as_deref() {
        None => ProfileKind::Missing,
        Some(target_type) if numeric_type(source_type) && numeric_type(target_type) => {
            ProfileKind::Numeric
        }
        Some(target_type) if source_type != target_type => ProfileKind::Incompatible,
        Some(target_type) if categorical_type(target_type) => ProfileKind::Categorical,
        Some(_) => ProfileKind::Unsupported,
    };
    let exact_integer =
        integer_type(source_type) && target_type.as_deref().is_some_and(integer_type);
    let sql = profile_query(&identifier(column), kind, exact_integer);
    let [profile] = serde_json::from_str::<[Value; 1]>(&execute(&select_script(&setup, &sql, 1))?)
        .map_err(|_| "DuckDB returned an incomplete comparison profile.".to_owned())?;
    Ok(json!({
        "profileColumn": column,
        "kind": kind,
        "exactInteger": exact_integer,
        "types": [Some(source_type), target_type.as_ref()],
        "files": profile["files"],
        "distribution": profile["distribution"],
    }))
}

#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum ProfileKind {
    Numeric,
    Categorical,
    Missing,
    Incompatible,
    Unsupported,
}

fn setup_files(source: &str, target: &str) -> Result<String, String> {
    if !parquet_path(target) || source == target {
        return Err("Choose a different Parquet file.".into());
    }
    let mut setup = setup_sql(source, &[target])?;
    setup.push_str(&format!(
        " CREATE VIEW parquet_target AS SELECT * FROM read_parquet({});",
        sql_string(target)
    ));
    Ok(setup)
}

fn identifier(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn numeric_type(name: &str) -> bool {
    integer_type(name)
        || matches!(name, "HUGEINT" | "UHUGEINT" | "FLOAT" | "DOUBLE")
        || name.starts_with("DECIMAL(")
}

fn integer_type(name: &str) -> bool {
    matches!(
        name,
        "TINYINT"
            | "SMALLINT"
            | "INTEGER"
            | "BIGINT"
            | "UTINYINT"
            | "USMALLINT"
            | "UINTEGER"
            | "UBIGINT"
    )
}

fn categorical_type(name: &str) -> bool {
    matches!(
        name,
        "VARCHAR"
            | "BOOLEAN"
            | "BLOB"
            | "UUID"
            | "DATE"
            | "TIME"
            | "TIME_NS"
            | "TIME WITH TIME ZONE"
            | "TIMESTAMP"
            | "TIMESTAMP_S"
            | "TIMESTAMP_MS"
            | "TIMESTAMP_NS"
            | "TIMESTAMP WITH TIME ZONE"
            | "INTERVAL"
    )
}

fn profile_query(column: &str, kind: ProfileKind, exact_integer: bool) -> String {
    let source = file_summary("parquet_data", Some(column), kind == ProfileKind::Numeric);
    let target = file_summary(
        "parquet_target",
        (kind != ProfileKind::Missing).then_some(column),
        kind == ProfileKind::Numeric,
    );
    let (with, distribution) = match kind {
        ProfileKind::Numeric => (
            numeric_distribution(column, exact_integer),
            "(SELECT coalesce(list(distribution ORDER BY bin), []) FROM distribution)",
        ),
        ProfileKind::Categorical => (
            categorical_distribution(column),
            "(SELECT coalesce(list(distribution ORDER BY position), []) FROM distribution)",
        ),
        ProfileKind::Missing | ProfileKind::Incompatible | ProfileKind::Unsupported => {
            (String::new(), "[]")
        }
    };
    format!("{with} SELECT [{source}, {target}] AS files, {distribution} AS distribution")
}

fn file_summary(table: &str, column: Option<&str>, numeric: bool) -> String {
    let mut summary = "rows := count(*)::VARCHAR".to_owned();
    if let Some(column) = column {
        let column = format!("file.{column}");
        summary.push_str(&format!(", nulls := (count(*) - count({column}))::VARCHAR"));
        if numeric {
            let finite = format!("FILTER (WHERE isfinite({column}::DOUBLE))");
            let mean = format!("avg({column}::DOUBLE) {finite}");

            // Dividing by 2^64 keeps the fallback sum finite over a 64-bit row count
            const MEAN_DIVISOR: &str = "18446744073709551616.0::DOUBLE";
            summary.push_str(&format!(
                ", nonfinite := (count({column}) - count(*) {finite})::VARCHAR,
                   minimum := (min({column}) {finite})::VARCHAR,
                   mean := (CASE WHEN isfinite({mean}) THEN {mean}
                                 ELSE avg({column}::DOUBLE / {MEAN_DIVISOR}) {finite} * {MEAN_DIVISOR}
                            END)::VARCHAR,
                   maximum := (max({column}) {finite})::VARCHAR"
            ));
        }
    } else {
        summary.push_str(", nulls := NULL::VARCHAR");
    }
    format!("(SELECT struct_pack({summary}) FROM {table} AS file)")
}

fn numeric_distribution(column: &str, exact_integer: bool) -> String {
    const BINS: u32 = 20;
    let (value_type, bins, bin, lower, upper) = if exact_integer {
        (
            "HUGEINT",
            format!("least({BINS}, span)::BIGINT"),
            "((value - lo) * bins) // span",
            "lo + ((span * grid.bin + bins - 1) // bins)",
            "lo + ((span * (grid.bin + 1) + bins - 1) // bins)",
        )
    } else {
        (
            "DOUBLE",
            format!("CASE WHEN lo = hi THEN 1 ELSE {BINS} END"),
            "CASE WHEN lo = hi THEN 0 ELSE least(bins - 1, floor((value / divisor - lo / divisor) /
                 (hi / divisor - lo / divisor) * bins)) END",
            "lo * (1 - grid.bin / bins) + hi * (grid.bin / bins)",
            "lo * (1 - (grid.bin + 1) / bins) + hi * ((grid.bin + 1) / bins)",
        )
    };
    format!(
        "WITH data AS NOT MATERIALIZED (
            SELECT 0 AS side, {column}::{value_type} AS value FROM parquet_data
            UNION ALL
            SELECT 1 AS side, {column}::{value_type} AS value FROM parquet_target
         ), extent AS (
            SELECT min(value) AS lo, max(value) AS hi, hi - lo + 1 AS span FROM data WHERE isfinite(value::DOUBLE)
         ), bounds AS (
            SELECT lo, hi, span, {bins} AS bins,
                   CASE WHEN isinf(hi::DOUBLE - lo::DOUBLE) THEN 2.0 ELSE 1.0 END AS divisor FROM extent
         ), counts AS (
            SELECT {bin} AS bin,
                   count(*) FILTER (WHERE side = 0) AS opened,
                   count(*) FILTER (WHERE side = 1) AS selected
            FROM data CROSS JOIN bounds WHERE isfinite(value::DOUBLE) GROUP BY bin
         ), distribution AS (
            SELECT grid.bin,
                   ({lower})::VARCHAR AS lower,
                   (CASE WHEN grid.bin = bins - 1 THEN hi ELSE {upper} END)::VARCHAR AS upper,
                   coalesce(opened, 0)::VARCHAR AS opened, coalesce(selected, 0)::VARCHAR AS selected
            FROM bounds CROSS JOIN range({BINS}) AS grid(bin) LEFT JOIN counts USING (bin)
            WHERE lo IS NOT NULL AND grid.bin < bins
         )"
    )
}

fn categorical_distribution(column: &str) -> String {
    const TOP: u32 = 12;
    format!(
        "WITH data AS (
            SELECT 0 AS side, {column}::VARCHAR AS value FROM parquet_data WHERE {column} IS NOT NULL
            UNION ALL
            SELECT 1 AS side, {column}::VARCHAR AS value FROM parquet_target WHERE {column} IS NOT NULL
         ), counts AS (
            SELECT value, count(*) FILTER (WHERE side = 0) AS opened,
                   count(*) FILTER (WHERE side = 1) AS selected FROM data GROUP BY value
         ), shares AS (
            SELECT *, greatest(opened / nullif(sum(opened) OVER (), 0),
                               selected / nullif(sum(selected) OVER (), 0)) AS share FROM counts
         ), ranked AS (
            SELECT *, row_number() OVER (ORDER BY share DESC, value) AS position FROM shares
         ), distribution AS (
            SELECT CASE WHEN length(value) > 120 THEN left(value, 120) || '...' || left(md5(value), 8)
                        ELSE value END AS label,
                   opened::VARCHAR AS opened, selected::VARCHAR AS selected, position
            FROM ranked WHERE position <= {TOP}
            UNION ALL
            SELECT NULL, sum(opened)::VARCHAR, sum(selected)::VARCHAR, {TOP} + 1
            FROM ranked WHERE position > {TOP} HAVING count(*) > 0
         )"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::run_cli;

    fn profile_result(
        setup: &str,
        column: &str,
        kind: ProfileKind,
        exact_integer: bool,
    ) -> Option<Value> {
        let query = profile_query(&identifier(column), kind, exact_integer);
        let result = match run_cli(&select_script(setup, &query, 1)) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
            result => result.unwrap(),
        };
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let [profile] = serde_json::from_slice::<[Value; 1]>(&result.stdout).unwrap();
        Some(profile)
    }

    #[test]
    fn compares_integer_histograms_exactly_above_double_precision() {
        let Some(result) = profile_result(
            "CREATE TABLE parquet_data(scale BIGINT, bins INTEGER, lo INTEGER);
             INSERT INTO parquet_data VALUES (9007199254740992, 1, 2), (NULL, 3, 4);
             CREATE TABLE parquet_target(scale UBIGINT);
             INSERT INTO parquet_target VALUES (9007199254740993);",
            "scale",
            ProfileKind::Numeric,
            true,
        ) else {
            return;
        };
        assert_eq!(
            result["files"],
            json!([
                {"rows": "2", "nulls": "1", "nonfinite": "0", "minimum": "9007199254740992", "maximum": "9007199254740992", "mean": "9007199254740992.0"},
                {"rows": "1", "nulls": "0", "nonfinite": "0", "minimum": "9007199254740993", "maximum": "9007199254740993", "mean": "9007199254740992.0"},
            ])
        );
        assert_eq!(
            result["distribution"],
            json!([
                {"bin": 0, "lower": "9007199254740992", "upper": "9007199254740993", "opened": "1", "selected": "0"},
                {"bin": 1, "lower": "9007199254740993", "upper": "9007199254740993", "opened": "0", "selected": "1"},
            ])
        );
    }

    #[test]
    fn compares_finite_distributions_and_computes_each_mean_independently() {
        let Some(result) = profile_result(
            "CREATE TABLE parquet_data(x DOUBLE);
             INSERT INTO parquet_data VALUES (1e-300), ('NaN'), (NULL);
             CREATE TABLE parquet_target(x DOUBLE);
             INSERT INTO parquet_target SELECT 1e308 FROM range(3);",
            "x",
            ProfileKind::Numeric,
            false,
        ) else {
            return;
        };
        assert_eq!(
            result["files"],
            json!([
                {"rows": "3", "nulls": "1", "nonfinite": "1", "minimum": "1e-300", "maximum": "1e-300", "mean": "1e-300"},
                {"rows": "3", "nulls": "0", "nonfinite": "0", "minimum": "1e+308", "maximum": "1e+308", "mean": "1e+308"},
            ])
        );
        let bins = result["distribution"].as_array().unwrap();
        assert_eq!(bins.len(), 20);
        assert_eq!(
            bins[0],
            json!({"bin": 0, "lower": "1e-300", "upper": "5.0000000000000006e+306", "opened": "1", "selected": "0"})
        );
        assert_eq!(
            bins[19],
            json!({"bin": 19, "lower": "9.5e+307", "upper": "1e+308", "opened": "0", "selected": "3"})
        );
        assert!(
            bins[1..19]
                .iter()
                .all(|bin| bin["opened"] == "0" && bin["selected"] == "0")
        );
    }

    #[test]
    fn compares_categories_with_a_shared_other_bucket() {
        let Some(result) = profile_result(
            "CREATE TABLE parquet_data(x VARCHAR);
             INSERT INTO parquet_data VALUES ('open'), ('open'), ('shared'), (NULL);
             CREATE TABLE parquet_target(x VARCHAR);
             INSERT INTO parquet_target VALUES ('shared'), ('selected'), ('selected');
             INSERT INTO parquet_target SELECT 'extra ' || i FROM range(12) t(i);",
            "x",
            ProfileKind::Categorical,
            false,
        ) else {
            return;
        };
        assert_eq!(
            result["files"],
            json!([
                {"rows": "4", "nulls": "1"}, {"rows": "15", "nulls": "0"},
            ])
        );
        let categories = result["distribution"].as_array().unwrap();
        assert_eq!(categories.len(), 13);
        assert_eq!(
            categories[0],
            json!({"label": "open", "opened": "2", "selected": "0", "position": 1})
        );
        assert_eq!(
            categories[1],
            json!({"label": "shared", "opened": "1", "selected": "1", "position": 2})
        );
        assert_eq!(
            categories[2],
            json!({"label": "selected", "opened": "0", "selected": "2", "position": 3})
        );
        assert_eq!(
            categories[12],
            json!({"label": null, "opened": "0", "selected": "3", "position": 13})
        );
    }

    #[test]
    fn reports_available_counts_when_the_target_column_is_missing() {
        let Some(result) = profile_result(
            "CREATE TABLE parquet_data(x INTEGER);
             INSERT INTO parquet_data VALUES (1), (NULL);
             CREATE TABLE parquet_target(y INTEGER);
             INSERT INTO parquet_target VALUES (3);",
            "x",
            ProfileKind::Missing,
            false,
        ) else {
            return;
        };
        assert_eq!(
            result,
            json!({
                "files": [{"rows": "2", "nulls": "1"}, {"rows": "1", "nulls": null}],
                "distribution": [],
            })
        );
    }
}
