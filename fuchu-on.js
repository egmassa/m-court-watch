// 府中の監視がオンかどうかを調べる(オンなら 0、オフなら 1 で終わる)
// 友達が決めた条件(共有)があればそれを優先し、なければ config.yml を見る
const fs = require('fs');
const y = require('js-yaml').load(fs.readFileSync('config.yml', 'utf8')) || {};
let on = !!(y.fuchu && y.fuchu.enabled !== false);
const f = process.env.SHARED_COND_FILE;
if (f && fs.existsSync(f)) {
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (s.fuchu) on = !!s.fuchu.enabled;
}
process.exit(on ? 0 : 1);
