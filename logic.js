/* 竞彩工作台 —— 计算逻辑
 * 纯函数，不依赖任何库。浏览器和 Node 都能跑（方便自检）。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JCLogic = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const OUT = ['主胜', '平', '客胜'];
  const KELLY_GAP = 0.02; // 凯利比返还率低这么多，算"明显偏低"

  const TTG_ORDER = ['0', '1', '2', '3', '4', '5', '6', '7+'];

  const HAFU_ORDER = [
    '胜/胜', '胜/平', '胜/负',
    '平/胜', '平/平', '平/负',
    '负/胜', '负/平', '负/负',
  ];

  const CRS_GROUPS = [
    {
      label: '主胜',
      keys: ['1:0', '2:0', '2:1', '3:0', '3:1', '3:2', '4:0', '4:1', '4:2', '5:0', '5:1', '5:2', '胜其它'],
    },
    {
      label: '平',
      keys: ['0:0', '1:1', '2:2', '3:3', '平其它'],
    },
    {
      label: '客胜',
      keys: ['0:1', '0:2', '1:2', '0:3', '1:3', '2:3', '0:4', '1:4', '2:4', '0:5', '1:5', '2:5', '负其它'],
    },
  ];

  const sum = (a) => a.reduce((x, y) => x + y, 0);

  /* 返还率 = 1 / Σ(1/赔率)。缺项（undefined/NaN）自动忽略，避免算出 NaN。 */
  function payoutRate(odds) {
    const valid = odds.filter((o) => typeof o === 'number' && isFinite(o) && o > 1);
    if (!valid.length) return 0;
    return 1 / sum(valid.map((o) => 1 / o));
  }

  /* 归一化隐含概率（三项加起来 100%） */
  function impliedProbs(odds) {
    const inv = odds.map((o) => 1 / o);
    const s = sum(inv);
    return inv.map((v) => v / s);
  }

  /* 凯利指数 = 该项赔率 × 市场平均概率 */
  function kellyIndex(odds, probs) {
    return odds.map((o, j) => o * probs[j]);
  }

  /* ---------------- Coral 凯利 ---------------- */

  function coralMetrics(match) {
    const open = kellyIndex(match.coral.open, match.marketProb.open);
    const live = kellyIndex(match.coral.live, match.marketProb.live);
    const pay = payoutRate(match.coral.live);

    return {
      kellyOpen: open,
      kellyLive: live,
      delta: live.map((k, j) => k - open[j]),
      payout: pay,
      // 凯利比自己返还率低 0.02 以上 → 这家公司对这个结果给价偏保守
      low: live.map((k) => k < pay - KELLY_GAP),
      gap: live.map((k) => pay - k),
    };
  }

  /* ---------------- 竞彩各玩法 ---------------- */

  /* 传入 { "1:0": 6.2, ... } 和顺序，算出赔率数组、归一化概率、返还率 */
  function poolMetrics(oddsMap, order) {
    const odds = order.map((k) => oddsMap[k]);
    const probs = impliedProbs(odds);
    return {
      labels: order,
      odds,
      probs,
      payout: payoutRate(odds),
    };
  }

  function crsMetrics(oddsMap) {
    const groups = CRS_GROUPS.map((g) => {
      const odds = g.keys.map((k) => oddsMap[k]);
      return { label: g.label, keys: g.keys, odds, probs: impliedProbs(odds) };
    });
    const all = CRS_GROUPS.reduce((acc, g) => acc.concat(g.keys.map((k) => oddsMap[k])), []);
    return { groups, payout: payoutRate(all), count: all.length };
  }

  /* ---------------- 赛果与战绩 ---------------- */

  function outcomeIndex(score) {
    if (!score) return -1;
    if (score[0] > score[1]) return 0;
    if (score[0] === score[1]) return 1;
    return 2;
  }

  /* 交战历史：从"本场主队"的视角统计胜平负 */
  function h2hSummary(match) {
    let w = 0, d = 0, l = 0;
    match.h2h.forEach((x) => {
      const homeIsUs = x.home === match.home;
      const ours = homeIsUs ? x.score[0] : x.score[1];
      const theirs = homeIsUs ? x.score[1] : x.score[0];
      if (ours > theirs) w++;
      else if (ours === theirs) d++;
      else l++;
    });
    return { w, d, l, total: match.h2h.length };
  }

  /* 近 5 场：胜平负 + 进球/失球。

     注意：score 存的是真实比分「主队:客队」，所以算自己进了几个球时，
     必须看 venue（主/客），不能直接取 score[0]。 */
  function recentSummary(list) {
    let w = 0, d = 0, l = 0, gf = 0, ga = 0;
    list.forEach((x) => {
      const ours = x.venue === '主' ? x.score[0] : x.score[1];
      const theirs = x.venue === '主' ? x.score[1] : x.score[0];
      gf += ours; ga += theirs;
      if (ours > theirs) w++;
      else if (ours === theirs) d++;
      else l++;
    });
    return { w, d, l, gf, ga, total: list.length };
  }

  /* ---------------- 联赛汇总 ---------------- */

  /* 竞彩编号形如 周二001、周日012 */
  const NO_PATTERN = /^周[一二三四五六日]\d{3}$/;

  /* 是不是竞彩真正开售的场次。
     判断依据：必须有合法的竞彩编号 + 明确的在售/完场状态。
     数据源就是竞彩官方，正常情况下每场必然满足；这条是硬保险——
     以后万一接了别的数据源，也不会把"联赛里的其他比赛"混进来。 */
  function isOnSale(m) {
    return !!(
      m &&
      m.no &&
      NO_PATTERN.test(String(m.no)) &&
      (m.status === '在售' || m.status === '已完场')
    );
  }

  function onSaleMatches(matches) {
    return matches.filter(isOnSale);
  }

  /* 竞彩期号：按"开售日"（businessDate）算，不是按开球日。
     所以「周二005」可能是周三凌晨 01:30 开球——和竞彩官方一致。
     老数据没有 businessDate 时，退回用开球日。 */
  function periodOf(m) {
    return m.businessDate || m.kickoff.slice(0, 10);
  }

  const WEEK_CN = '日一二三四五六';

  function weekdayOf(dateStr) {
    const p = dateStr.split('-');
    const d = new Date(+p[0], +p[1] - 1, +p[2]);
    return '周' + WEEK_CN[d.getDay()];
  }

  /* 按联赛统计：开了几场、分别是在哪几期开的。只数竞彩开售的。 */
  function leagueSummary(matches) {
    const map = {};
    onSaleMatches(matches).forEach((m) => {
      if (!map[m.league]) map[m.league] = { name: m.league, total: 0, done: 0, live: 0, byPeriod: {} };
      const s = map[m.league];
      s.total++;
      if (m.status === '已完场') s.done++;
      else s.live++;
      const p = periodOf(m);
      s.byPeriod[p] = (s.byPeriod[p] || 0) + 1;
    });

    return Object.keys(map)
      .map((k) => {
        const s = map[k];
        s.periods = Object.keys(s.byPeriod)
          .sort()
          .map((date) => ({ date, day: weekdayOf(date), count: s.byPeriod[date] }));
        delete s.byPeriod;
        return s;
      })
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'zh'));
  }

  /* 按竞彩期号分组，期号从早到晚，组内按开球时间排 */
  function groupByPeriod(matches) {
    const map = {};
    matches.forEach((m) => {
      const p = periodOf(m);
      if (!map[p]) map[p] = [];
      map[p].push(m);
    });
    return Object.keys(map)
      .sort()
      .map((date) => ({
        date,
        day: weekdayOf(date),
        items: map[date].sort((a, b) => (a.kickoff < b.kickoff ? -1 : a.kickoff > b.kickoff ? 1 : 0)),
      }));
  }

  /* 把一个联赛的赛事拆成"马上要开"和"已经打完"，同样只取竞彩开售的 */
  function splitByStatus(matches) {
    const list = onSaleMatches(matches);
    const byKick = (a, b) => (a.kickoff < b.kickoff ? -1 : a.kickoff > b.kickoff ? 1 : 0);
    const upcoming = list.filter((m) => m.status !== '已完场').sort(byKick);
    const past = list.filter((m) => m.status === '已完场').sort((a, b) => byKick(b, a));
    return { upcoming, past };
  }

  /* ---------------- 每日汇总 ---------------- */

  function parseDate(s) {
    const p = s.split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }

  const WEEK = '日一二三四五六';

  /* 相对说法：今天 / 昨天 / 前天 / 明天，其余给「10/24 周五」 */
  function dayLabel(dateStr, todayStr) {
    const d = parseDate(dateStr);
    const diff = Math.round((parseDate(todayStr) - d) / 86400000);
    if (diff === 0) return '今天';
    if (diff === 1) return '昨天';
    if (diff === 2) return '前天';
    if (diff === -1) return '明天';
    return dateStr.slice(5).replace('-', '/') + ' 周' + WEEK[d.getDay()];
  }

  /* 按天汇总：这一天竞彩开了哪几个联赛、各几场。
     只统计竞彩真正开售的场次——联赛里那些没开售的比赛不算进来。 */
  function dailySummary(matches, todayStr) {
    const map = {};
    onSaleMatches(matches).forEach((m) => {
      const d = m.kickoff.slice(0, 10);
      if (!map[d]) map[d] = { date: d, total: 0, leagues: {} };
      map[d].total++;
      map[d].leagues[m.league] = (map[d].leagues[m.league] || 0) + 1;
    });

    return Object.keys(map)
      .sort((a, b) => b.localeCompare(a)) // 日期从新到旧
      .map((d) => {
        const x = map[d];
        return {
          date: d,
          total: x.total,
          label: dayLabel(d, todayStr),
          weekday: '周' + WEEK[parseDate(d).getDay()],
          leagues: Object.keys(x.leagues)
            .map((name) => ({ name, count: x.leagues[name] }))
            .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh')),
        };
      });
  }

  /* ---------------- 竞彩官方数据 → 内部模型 ---------------- */

  const HAFU_LABEL = {
    hh: '胜/胜', hd: '胜/平', ha: '胜/负',
    dh: '平/胜', dd: '平/平', da: '平/负',
    ah: '负/胜', ad: '负/平', aa: '负/负',
  };

  const CRS_LABEL = { s1sh: '胜其它', s1sd: '平其它', s1sa: '负其它' };

  function crsLabelOf(code) {
    if (CRS_LABEL[code]) return CRS_LABEL[code];
    const m = /^s(\d{2})s(\d{2})$/.exec(code);
    return m ? Number(m[1]) + ':' + Number(m[2]) : null;
  }

  function toNum(v) {
    const n = parseFloat(v);
    return isFinite(n) && n > 1 ? n : null;
  }

  /* {"h":"1.57","d":"3.98","a":"4.15"} → [1.57, 3.98, 4.15]，缺一个就返回 null */
  function threeWay(o) {
    if (!o) return null;
    const arr = [toNum(o.h), toNum(o.d), toNum(o.a)];
    return arr.some((x) => x === null) ? null : arr;
  }

  /* 把 crs/ttg/hafu 的"码 → 赔率"转成"标签 → 赔率" */
  function codeMapToLabels(src, mapper) {
    const out = {};
    if (!src) return out;
    Object.keys(src).forEach((k) => {
      if (k.slice(-1) === 'f') return;        // 带 f 的是涨跌标记，不是赔率
      const label = mapper(k);
      const v = toNum(src[k]);
      if (label && v !== null) out[label] = v;
    });
    return out;
  }

  /* 单场竞彩比赛 → 内部模型。
     这个接口只给赛程和赔率，没有比分、没有交战历史、没有 Coral。
     缺的字段一律留空，界面会显示"未接入"。 */
  function parseSportteryMatch(it) {
    if (!it || !it.matchId) return null;

    const had = threeWay(it.had);
    if (!had) return null;                    // 没开盘的跳过

    const hhad = threeWay(it.hhad);
    const lineRaw = parseFloat(it.hhad && it.hhad.goalLineValue);
    const line = isFinite(lineRaw) ? lineRaw : 0;

    const time = (it.matchTime || '00:00').slice(0, 5);
    const date = it.matchDate || it.businessDate || '';
    const ended = /end|finish|result|完/i.test(it.matchStatus || '');

    return {
      id: String(it.matchId),
      no: it.matchNumStr || '',
      businessDate: it.businessDate || date,
      league: it.leagueAbbName || '',
      home: it.homeTeamAbbName || '',
      away: it.awayTeamAbbName || '',
      kickoff: date + ' ' + time,
      status: ended ? '已完场' : '在售',
      result: null,
      ht: null,
      src: 'jc',
      jc: {
        line: line,
        had: { odds: had, payout: payoutRate(had) },
        hhad: hhad
          ? { odds: hhad, payout: payoutRate(hhad) }
          : { odds: had, payout: payoutRate(had) },
        crs: { odds: codeMapToLabels(it.crs, crsLabelOf) },
        ttg: {
          odds: codeMapToLabels(it.ttg, (k) =>
            /^s[0-7]$/.test(k) ? (k === 's7' ? '7+' : k.slice(1)) : null),
        },
        hafu: { odds: codeMapToLabels(it.hafu, (k) => HAFU_LABEL[k] || null) },
      },
      /* 云端函数会在这两项里塞 Coral 赔率和市场平均概率；
         没有的话就是 null，界面显示"未接入"。 */
      coral: it.coral || null,
      marketProb: it.marketProb || null,
      h2h: [],
      recent: { home: [], away: [] },
    };
  }

  /* 整个接口响应 → 比赛数组 */
  function parseSporttery(raw) {
    const groups = (raw && raw.value && raw.value.matchInfoList) || [];
    const out = [];
    groups.forEach((g) => {
      (g.subMatchList || []).forEach((it) => {
        const m = parseSportteryMatch(it);
        if (m) out.push(m);
      });
    });
    return out;
  }

  /* ---------------- 指数码（盘型码 / 凯利码） ---------------- */

  /* 赔率 → 盘型码：每个赔率取整数位拼成三位。
     1.66 / 3.78 / 3.93 → "133"。十以上记作 9，否则位数会乱。 */
  function oddsCode(odds) {
    return odds.map((o) => {
      const v = Math.floor(o);
      return v > 9 ? '9' : String(v);
    }).join('');
  }

  /* 凯利 → 两位小数码：0.970 / 0.980 / 0.892 → "97/98/89"。
     凯利都在 0.xx，取整数位全是 0 没有意义，所以取小数后两位。 */
  function kellyCode(kelly) {
    return kelly.map((k) => String(Math.round(k * 100)).padStart(2, '0')).join('/');
  }

  /* 一场比赛的四组码。没有 Coral 数据时，凯利两项返回 null，
     界面和统计都要能跳过它们（真实竞彩数据暂时没有 Coral）。 */
  function matchCodes(m) {
    const hasCoral = !!(m && m.coral && m.marketProb);
    const c = hasCoral ? coralMetrics(m) : null;
    const jc = (m && m.jc) || {};
    return {
      had: jc.had && jc.had.odds ? oddsCode(jc.had.odds) : null,
      hhad: jc.hhad && jc.hhad.odds ? oddsCode(jc.hhad.odds) : null,
      kelly: c ? kellyCode(c.kellyLive) : null,
      kellyOpen: c ? kellyCode(c.kellyOpen) : null,
    };
  }

  const INDEX_DIMS = ['had', 'hhad', 'kelly', 'kellyOpen'];

  /* 统计每个维度分别出现过哪些码、各几次（次多的排前面） */
  function indexGroups(matches) {
    const acc = {};
    INDEX_DIMS.forEach((d) => { acc[d] = {}; });

    matches.forEach((m) => {
      const c = matchCodes(m);
      INDEX_DIMS.forEach((d) => {
        if (c[d] === null) return;            // 这项没有数据就跳过
        acc[d][c[d]] = (acc[d][c[d]] || 0) + 1;
      });
    });

    const out = {};
    INDEX_DIMS.forEach((d) => {
      out[d] = Object.keys(acc[d])
        .map((code) => ({ code, count: acc[d][code] }))
        .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
    });
    return out;
  }

  /* 预先算好每场的四组码，避免组合筛选时反复重算 */
  function indexEntries(matches) {
    return matches.map((m) => ({ match: m, codes: matchCodes(m) }));
  }

  /* 组合筛选：sel 里每个非空的维度都必须同时满足（AND）。
     sel 形如 { had: '232', kelly: '97/98/89', hhad: null, kellyOpen: null } */
  function filterEntries(entries, sel) {
    const dims = INDEX_DIMS.filter((d) => sel && sel[d]);
    if (!dims.length) return entries.slice();
    return entries.filter((e) => dims.every((d) => e.codes[d] === sel[d]));
  }

  /* ---------------- 存档（历史库） ---------------- */

  /* 把新抓到的比赛并进历史库。
     - 已有记录：保留用户自己填的赛果（userResult）
     - 新数据缺的战绩/欧赔，沿用旧记录里的（竞彩接口不给这些）
     - 新记录：直接加入
     - 不删除任何旧记录（除非 prune 裁剪） */
  function mergeIntoArchive(archive, incoming) {
    const next = Object.assign({}, archive);
    (incoming || []).forEach((m) => {
      const old = next[m.id];
      const rec = Object.assign({}, m);
      if (old) {
        if (old.userResult && old.result) {
          rec.result = old.result;
          rec.ht = old.ht || null;
          rec.userResult = true;
          rec.status = '已完场';
        } else if (!rec.result && old.result) {
          rec.result = old.result;
          rec.ht = old.ht || null;
        }

        // 竞彩接口没有交战历史 / 近 5 场 / Coral，别把旧的冲掉
        if ((!rec.h2h || !rec.h2h.length) && old.h2h && old.h2h.length) rec.h2h = old.h2h;
        if ((!rec.recent || !((rec.recent.home || []).length)) &&
            old.recent && ((old.recent.home || []).length || (old.recent.away || []).length)) {
          rec.recent = old.recent;
        }
        if (!rec.coral && old.coral) {
          rec.coral = old.coral;
          rec.marketProb = old.marketProb;
        }

        /* 「初始凯利」= 第一次看到这份赔率时的值。
           接口只给当前价，没有开盘价，所以把最早抓到的 live 存成 open，
           之后每次合并都保留它，这样才看得出盘口往哪边动。 */
        if (rec.coral && old.coral && old.coral.open) {
          rec.coral = { open: old.coral.open, live: rec.coral.live };
        }
        if (rec.marketProb && old.marketProb && old.marketProb.open) {
          rec.marketProb = { open: old.marketProb.open, live: rec.marketProb.live };
        }
      }
      next[m.id] = rec;
    });
    return next;
  }

  /* 裁剪：按开赛时间从新到旧保留最多 cap 条，
     但有判断记录的比赛一律保留（那是用户的研究成果，不能丢）。 */
  function pruneArchive(archive, journalMatchIds, cap) {
    const list = Object.keys(archive)
      .map((k) => archive[k])
      .sort((a, b) => (a.kickoff < b.kickoff ? 1 : a.kickoff > b.kickoff ? -1 : 0));

    const keep = new Set(journalMatchIds || []);
    const out = {};
    list.forEach((m, i) => {
      if (i < cap || keep.has(m.id)) out[m.id] = m;
    });
    return out;
  }

  /* 历史库 → 数组，新比赛在前 */
  function archiveToList(archive) {
    return Object.keys(archive)
      .map((k) => archive[k])
      .sort((a, b) => (a.kickoff < b.kickoff ? 1 : a.kickoff > b.kickoff ? -1 : 0));
  }

  /* 导入时合并两个历史库：本地已有用户赛果的优先，否则用导入的 */
  function mergeArchiveMaps(localMap, incomingMap) {
    const out = Object.assign({}, localMap);
    Object.keys(incomingMap || {}).forEach((id) => {
      const inc = incomingMap[id];
      const cur = out[id];
      if (!cur) { out[id] = inc; return; }
      if (cur.userResult && !inc.userResult) return;
      out[id] = Object.assign({}, cur, inc);
      if (cur.userResult && cur.result) {
        out[id].result = cur.result;
        out[id].ht = cur.ht || null;
        out[id].userResult = true;
        out[id].status = '已完场';
      }
    });
    return out;
  }

  /* 导入时合并判断记录：同一场比赛取时间更新的那条 */
  function mergeJournals(localList, incomingList) {
    const map = {};
    (localList || []).forEach((e) => { map[e.matchId] = e; });
    (incomingList || []).forEach((e) => {
      const cur = map[e.matchId];
      if (!cur || String(e.savedAt || '') >= String(cur.savedAt || '')) map[e.matchId] = e;
    });
    return Object.keys(map).map((k) => map[k]);
  }

  /* ---------------- 判断记录 ---------------- */

  /* 一条记录能不能判定对错：比赛必须有赛果 */
  function judge(entry, match) {
    if (!match || !match.result) return { settled: false, correct: null, actual: -1 };
    const actual = outcomeIndex(match.result);
    return { settled: true, correct: actual === entry.pick, actual };
  }

  function pickLabel(pick) {
    return OUT[pick] || '—';
  }

  return {
    OUT,
    TTG_ORDER,
    HAFU_ORDER,
    CRS_GROUPS,
    KELLY_GAP,
    payoutRate,
    impliedProbs,
    kellyIndex,
    coralMetrics,
    poolMetrics,
    crsMetrics,
    outcomeIndex,
    h2hSummary,
    recentSummary,
    isOnSale,
    onSaleMatches,
    periodOf,
    weekdayOf,
    leagueSummary,
    groupByPeriod,
    splitByStatus,
    oddsCode,
    kellyCode,
    matchCodes,
    indexGroups,
    indexEntries,
    filterEntries,
    INDEX_DIMS,
    dailySummary,
    dayLabel,
    judge,
    pickLabel,
    mergeIntoArchive,
    pruneArchive,
    archiveToList,
    mergeArchiveMaps,
    mergeJournals,
    parseSporttery,
    parseSportteryMatch,
  };
});
