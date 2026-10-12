// 行级 diff（LCS 动态规划，带规模上限）。core/diff.mjs
export function makeDiff(oldText, newText, { maxLines = 400, context = 2 } = {}) {
  const a = String(oldText ?? "").split("\n");
  const b = String(newText ?? "").split("\n");
  if (a.length > maxLines || b.length > maxLines) {
    return { kind: "diff", big: true, lines: [], note: `内容较大（旧 ${a.length} 行 / 新 ${b.length} 行），仅展示前 ${maxLines} 行对比` , previewLines: simpleDiff(a.slice(0, maxLines), b.slice(0, maxLines)) };
  }
  return { kind: "diff", big: false, lines: simpleDiff(a, b) };
}

export function simpleDiff(a, b) {
  const n = a.length,
    m = b.length;
  // 先剥掉公共前后缀，缩小 DP 规模
  let p = 0;
  while (p < n && p < m && a[p] === b[p]) p++;
  let s = 0;
  while (s < n - p && s < m - p && a[n - 1 - s] === b[m - 1 - s]) s++;
  const midA = a.slice(p, n - s),
    midB = b.slice(p, m - s);
  const out = [];
  for (let i = 0; i < p; i++) out.push({ op: " ", text: a[i], an: i + 1, bn: i + 1 });
  // 中段做 LCS（规模受控）
  const na = midA.length,
    nb = midB.length;
  if (na * nb > 250000) {
    for (let i = 0; i < na; i++) out.push({ op: "-", text: midA[i], an: p + i + 1 });
    for (let j = 0; j < nb; j++) out.push({ op: "+", text: midB[j], bn: p + j + 1 });
  } else {
    const dp = Array.from({ length: na + 1 }, () => new Uint16Array(nb + 1));
    for (let i = na - 1; i >= 0; i--)
      for (let j = nb - 1; j >= 0; j--)
        dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0,
      j = 0;
    while (i < na && j < nb) {
      if (midA[i] === midB[j]) {
        out.push({ op: " ", text: midA[i], an: p + i + 1, bn: p + j + 1 });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        out.push({ op: "-", text: midA[i], an: p + i + 1 });
        i++;
      } else {
        out.push({ op: "+", text: midB[j], bn: p + j + 1 });
        j++;
      }
    }
    while (i < na) out.push({ op: "-", text: midA[i], an: p + i + 1 }), i++;
    while (j < nb) out.push({ op: "+", text: midB[j], bn: p + j + 1 }), j++;
  }
  for (let k = 0; k < s; k++) out.push({ op: " ", text: a[n - s + k], an: n - s + k + 1, bn: m - s + k + 1 });
  return out;
}

// 统计 +/- 行数
export function diffStat(lines) {
  let add = 0,
    del = 0;
  for (const l of lines) {
    if (l.op === "+") add++;
    else if (l.op === "-") del++;
  }
  return { add, del };
}
