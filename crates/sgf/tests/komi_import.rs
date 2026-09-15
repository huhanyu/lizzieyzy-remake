#[test]
fn imported_fixed_point_komi_reaches_game_summary() {
    let input = "(;AP[GNU Go:3.8]RU[Chinese]SZ[19]KM[375];B[pd];W[dd])";
    let game = sgf::parse_sgf(input).unwrap();
    assert_eq!(game.komi, 7.5);
    let standard = sgf::parse_sgf("(;AP[Sabaki]SZ[19]KM[375])").unwrap();
    assert_eq!(standard.komi, 375.0);
}
