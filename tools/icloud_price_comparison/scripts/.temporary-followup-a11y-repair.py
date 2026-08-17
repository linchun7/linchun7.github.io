from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
STYLE = ROOT / 'tools' / 'icloud_price_comparison' / 'style.css'
text = STYLE.read_text(encoding='utf-8')

old = ".mobile-rank { display: none; }\n.mobile-rank-sr { display: none; }\n"
if text.count(old) != 1:
    raise SystemExit('expected one global mobile-rank-sr display rule')
text = text.replace(old, ".mobile-rank { display: none; }\n", 1)

mobile_override = "  .mobile-rank-sr { display: block; }\n"
if text.count(mobile_override) != 1:
    raise SystemExit('expected one mobile-rank-sr mobile override')
text = text.replace(mobile_override, '', 1)

desktop_anchor = "@media (min-width: 1101px) {\n  .workspace-toolbar { min-height: 101px; }"
if text.count(desktop_anchor) != 1:
    raise SystemExit('expected desktop media anchor')
text = text.replace(
    desktop_anchor,
    "@media (min-width: 1101px) {\n  .mobile-rank-sr { display: none; }\n  .workspace-toolbar { min-height: 101px; }",
    1
)

STYLE.write_text(text, encoding='utf-8')
print('mobile rank accessibility visibility repaired')
