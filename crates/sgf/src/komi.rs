/// Compatibility for the fixed-point export dialect seen in GNU Go:3.8-tagged
/// online records. Standard SGF numeric KM values must remain unchanged.
pub(crate) fn imported_komi(raw: &str, application: Option<&str>) -> Option<f32> {
    let mut value = raw.trim().parse::<f32>().ok()?;
    if !value.is_finite() { return None; }
    if application == Some("GNU Go:3.8") && value >= 200.0 && value.fract() == 0.0 {
        value /= 100.0;
        // Match Java's legacy import convention: small values or quarter units
        // represent stones; the engine and UI consistently use points.
        let fraction = value.fract().abs();
        if value.abs() <= 4.0 || fraction == 0.25 || fraction == 0.75 { value *= 2.0; }
    }
    Some(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_exports_match_java_conversion() {
        for (raw, expected) in [("375",7.5),("650",6.5),("750",7.5),("675",13.5)] {
            assert_eq!(imported_komi(raw, Some("GNU Go:3.8")), Some(expected));
        }
    }
    #[test]
    fn standard_and_unknown_formats_are_not_rescaled() {
        for raw in ["7.5", "6.5", "3.75", "375", "750", "-7.5"] {
            assert_eq!(imported_komi(raw, None), raw.parse().ok());
        }
        assert_eq!(imported_komi("7.5", Some("GNU Go:3.8")), Some(7.5));
        assert_eq!(imported_komi("NaN", None), None);
    }
}
