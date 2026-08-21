/* ============================================================
 * 亚马逊批量查排名 v1.1.18 — popup.js（UI 渲染 + 主流程）
 * 引擎逻辑见 core.js（两文件共享 window 作用域，popup.html 中 core.js 先加载）。
 * 本文件只负责：结果表格渲染 / 进度条 / 主流程 run-finish / 导出 Excel / 事件绑定。
 * ============================================================ */
'use strict';

/* ---------------- 渲染 ---------------- */
function rankTd(v) {
  return (v === null || v === undefined) ? '<td class="rank-none">-</td>' : '<td class="rank-hit">' + v + '</td>';
}
function renderTable() {
  var body = $('#resultBody');
  if (!results.length) {
    body.html('<tr><td colspan="19" class="empty-tip">粘贴 ASIN 和关键词后点击「开始查询」</td></tr>');
    return;
  }
  var html = '';
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    var href = 'https://www.amazon.' + r.site.domain + '/dp/' + r.asin;
    var tkey = r.site.key + '|' + r.kw;
    var arr = top6Cache[tkey] || [];
    var arrAd = top6AdCache[tkey] || [];
    var topHtml = '';
    /* 自然排名 TOP6 */
    for (var t = 0; t < 6; t++) {
      var p = arr[t];
      topHtml += '<td class="top-cell">';
      if (p) {
        var hit = (p.asin === r.asin) ? ' ta-hit' : '';
        topHtml += '<a href="https://www.amazon.' + r.site.domain + '/dp/' + p.asin + '" target="_blank">' +
          (p.img ? '<img src="' + esc(p.img) + '" loading="lazy" onerror="this.style.display=\'none\'">' : '') +
          '<span class="ta' + hit + '">' + esc(p.asin) + '</span></a>';
      }
      topHtml += '</td>';
    }
    /* 广告排名 TOP6（首列带细分隔线） */
    for (var ta = 0; ta < 6; ta++) {
      var pa = arrAd[ta];
      topHtml += '<td class="top-cell ad' + (ta === 0 ? ' ad-sep' : '') + '">';
      if (pa) {
        var hita = (pa.asin === r.asin) ? ' ta-hit' : '';
        topHtml += '<a href="https://www.amazon.' + r.site.domain + '/dp/' + pa.asin + '" target="_blank">' +
          (pa.img ? '<img src="' + esc(pa.img) + '" loading="lazy" onerror="this.style.display=\'none\'">' : '') +
          '<span class="ta' + hita + '">' + esc(pa.asin) + '</span></a>';
      }
      topHtml += '</td>';
    }
    html += '<tr>' +
      '<td>' + esc(r.site.name) + '</td>' +
      '<td><a href="' + href + '" target="_blank">' + esc(r.asin) + '</a></td>' +
      '<td class="kw" title="' + esc(r.kw) + '">' + esc(r.kw) + '</td>' +
      rankTd(r.nr) + rankTd(r.ar) + rankTd(r.nrM) + rankTd(r.arM) +
      topHtml +
      '</tr>';
  }
  body.html(html);
}
function updateProgress() {
  var pct = total ? Math.round(done / total * 100) : 0;
  $('#progressBar').width(pct + '%');
  var txt = '已完成 ' + done + ' / ' + total + '（' + pct + '%）';
  if (captchaCount) txt += '，验证码拦截 ' + captchaCount + ' 次';
  $('#statusText').text(txt);
}

/* ---------------- 主流程 ---------------- */
function run() {
  var text = $('#inputBox').val();
  var parsed = parseInput(text);
  if (!parsed.tasks.length) {
    alert(parsed.errs.length ? parsed.errs[0] : '请先输入 ASIN 和关键词（每行一组）');
    return;
  }
  running = true; stopFlag = false; captchaCount = 0;
  CONC = 3 + Math.floor(Math.random() * 3);   // 每次查询随机并发 3~5，请求模式不固定
  results = []; top6Cache = {}; top6AdCache = {};
  total = parsed.tasks.length; done = 0; queue = [];
  $('#resultBody').html('<tr><td colspan="19" class="empty-tip">查询中，请稍候…（' + total + ' 条任务）</td></tr>');
  $('#progressWrap').addClass('show');
  $('#btnRun').prop('disabled', true);
  $('#btnStop').prop('disabled', false);
  $('#btnExport').prop('disabled', true);
  $('#progressBar').width('0%');
  if (parsed.errs.length) $('#statusText').text('解析跳过 ' + parsed.errs.length + ' 行（如：' + parsed.errs[0] + '）');
  else $('#statusText').text('开始查询：' + total + ' 条任务…');
  /* 先按站点设置邮编（只设一次），再启动任务队列 */
  var zip = $('#zipInput').val().trim();
  var domains = [], seen = {};
  for (var i = 0; i < parsed.tasks.length; i++) {
    var d = parsed.tasks[i].site.domain;
    if (!seen[d]) { seen[d] = 1; domains.push(d); }
  }
  var chain = Promise.resolve();
  for (var k = 0; k < domains.length; k++) {
    (function (d) { chain = chain.then(function () { return setZip(d, zip); }); })(domains[k]);
  }
  chain.then(function () {
    if (stopFlag) return;
    for (var j = 0; j < parsed.tasks.length; j++) {
      enqueue((function (t) { return function () { return execTask(t); }; })(parsed.tasks[j]));
    }
  });
}
function finish() {
  running = false;
  $('#btnRun').prop('disabled', false);
  $('#btnStop').prop('disabled', true);
  $('#btnExport').prop('disabled', results.length ? false : true);
  $('#progressBar').width('100%');   // 全部完成时进度条拉满
  var txt = '全部完成：' + results.length + ' 行结果';
  if (captchaCount) txt += '，验证码拦截 ' + captchaCount + ' 次（可稍后重试）';
  $('#statusText').text(txt);
  renderTable();
}

/* ---------------- 导出 Excel ---------------- */
function exportExcel() {
  if (!results.length) { alert('暂无结果可导出'); return; }
  var head = ['站点', 'ASIN', '关键词', '自然排名', '广告排名', '自然排名(移动端)', '广告排名(移动端)', 'TOP1-ASIN', 'TOP2-ASIN', 'TOP3-ASIN', 'TOP4-ASIN', 'TOP5-ASIN', 'TOP6-ASIN', 'AD-TOP1-ASIN', 'AD-TOP2-ASIN', 'AD-TOP3-ASIN', 'AD-TOP4-ASIN', 'AD-TOP5-ASIN', 'AD-TOP6-ASIN'];
  var rows = [head];
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    var f = function (v) { return (v === null || v === undefined) ? '-' : v; };
    var tkey = r.site.key + '|' + r.kw;
    var arr = top6Cache[tkey] || [];
    var arrAd = top6AdCache[tkey] || [];
    var topAsins = [], topAdAsins = [];
    for (var t = 0; t < 6; t++) {
      topAsins.push(arr[t] ? arr[t].asin : '-');
      topAdAsins.push(arrAd[t] ? arrAd[t].asin : '-');
    }
    rows.push([r.site.name, r.asin, r.kw, f(r.nr), f(r.ar), f(r.nrM), f(r.arM)].concat(topAsins, topAdAsins));
  }
  var ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 8 }, { wch: 14 }, { wch: 32 }, { wch: 8 }, { wch: 8 }, { wch: 14 }, { wch: 14 }];
  for (var c = 0; c < 12; c++) ws['!cols'].push({ wch: 14 });
  var wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '排名结果');
  var d = new Date();
  var ds = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '_' + pad(d.getHours()) + '-' + pad(d.getMinutes()) + '-' + pad(d.getSeconds());
  XLSX.writeFile(wb, '亚马逊批量查排名_' + ds + '.xlsx');
}

/* ---------------- 初始化 ---------------- */
$(function () {
  var $sel = $('#siteSelect');
  for (var i = 0; i < SITES.length; i++) {
    $sel.append('<option value="' + SITES[i].key + '">' + SITES[i].name + '</option>');
  }
  $sel.val(curSite.key);
  $sel.change(function () {
    var k = $(this).val();
    for (var i = 0; i < SITES.length; i++) if (SITES[i].key === k) curSite = SITES[i];
  });
  $('#maxPages').change(function () { MAX_PAGES = parseInt($(this).val(), 10) || 5; });
  $('#btnRun').click(run);
  $('#btnStop').click(function () {
    stopFlag = true;
    var pending = queue.splice(0, queue.length);
    for (var i = 0; i < pending.length; i++) pending[i].resolve(null);
    $('#btnStop').prop('disabled', true);
    $('#statusText').text('正在停止（等待当前任务结束）…');
  });
  $('#btnExport').click(exportExcel);
});
