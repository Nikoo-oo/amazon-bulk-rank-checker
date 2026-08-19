/* ============================================================
 * 亚马逊批量查排名 v1.1.16（本地自用改造版）
 * - v1.1.16：修复"页面上有 SP 广告但插件抓不到"（漏抓根因）——浏览器实测确认
 *   亚马逊对连续/高频搜索请求做请求级随机降级，部分请求返回无广告基础版（48 项 0 广告，
 *   完整版 60 项 12 广告）。修复：①删除 Cache-Control/Pragma no-cache 头（与基础版强相关）；
 *   ②删除"目标 ASIN 不在结果中即重试"误判（完整版下目标不在就是真不在，广告 TOP6 照常列出）；
 *   ③基础版重试 3 次 → 4 次，间隔 5s/10s/15s/20s 递增随机，提高命中完整版概率
 * - v1.1.15：修复浏览器报错 "Refused to set unsafe header"——从请求头中删除
 *   Sec-Fetch 系列头 / Accept-Encoding / Upgrade-Insecure-Requests（浏览器禁止手动设置）；
 *   并明确广告范围：仅检查 SP 广告（Sponsored Products），SB 广告（品牌横幅/轮播、
 *   "Popular Shopping Ideas"/"From frequently shopped brands"、SBV 品牌视频）一律
 *   不做排名检查——SB 卡片位于轮播容器内、不属于 s-search-result，天然不参与解析。
 * - v1.1.13：跨页排名累计（自然/广告均按前页总数偏移）、补充 .AdHolder 广告识别
 * - v1.1.14：任务级失败重试——网络错误/超时/验证码时整条任务重跑（最多 3 次，
 *   间隔 2s/4s 递增随机），单次抖动不再直接记 null
 * - 反爬节奏 v1.1.12 起：并发 3~5 随机 + 间隔 700~2200ms 随机 + 重试间隔随机抖动
 * - 排名口径 v1.1.6 起与 Helium10/SellerSprite 对齐：自然位专用序号；仅自然位命中才算命中。
 * ============================================================ */
'use strict';

/* ---------------- 站点表（与 manifest host_permissions 对应） ---------------- */
var SITES = [
  { key: 'AmazonCOM', name: '美国',    domain: 'com' },
  { key: 'AmazonCA',  name: '加拿大',  domain: 'ca' },
  { key: 'AmazonUK',  name: '英国',    domain: 'co.uk' },
  { key: 'AmazonDE',  name: '德国',    domain: 'de' },
  { key: 'AmazonFR',  name: '法国',    domain: 'fr' },
  { key: 'AmazonES',  name: '西班牙',  domain: 'es' },
  { key: 'AmazonIT',  name: '意大利',  domain: 'it' },
  { key: 'AmazonJP',  name: '日本',    domain: 'co.jp' },
  { key: 'AmazonAU',  name: '澳大利亚',domain: 'com.au' },
  { key: 'AmazonBR',  name: '巴西',    domain: 'com.br' },
  { key: 'AmazonMX',  name: '墨西哥',  domain: 'com.mx' },
  { key: 'AmazonTR',  name: '土耳其',  domain: 'com.tr' },
  { key: 'AmazonNL',  name: '荷兰',    domain: 'nl' },
  { key: 'AmazonIN',  name: '印度',    domain: 'in' }
];

var UA_PC     = navigator.userAgent; // 当前浏览器（桌面）
var UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1';

/* 浏览器特征请求头（v1.1.8 起：完整化让 XHR 看起来像真实浏览器请求）。
 * v1.1.16 实测：Cache-Control: no-cache + Pragma: no-cache 与亚马逊"无广告基础版"返回强相关
 * （带此头 5 连发时第 4/5 个请求被降级；真实浏览器导航不带 no-cache），已删除。
 * 注意：Sec-Fetch 系列头 / Accept-Encoding / Upgrade-Insecure-Requests 属于浏览器禁止手动设置的安全头，
 * 在扩展 XHR 里设置会抛出 "Refused to set unsafe header" 导致请求失败。只保留安全的头。 */
var BASE_HDR_PC = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
  'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7'
};
var BASE_HDR_MOBILE = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9'
};
/* 真实浏览器 UA 通常带 Chrome 版本，sec-ch-ua 头部同步对齐；
 * 但我们不知道当前浏览器的 sec-ch-ua，所以不设——亚马逊对不带 sec-ch-ua 的请求容忍度比
 * 错配的 sec-ch-ua 高得多。 */

/* 赞助/广告文字识别（各站点语言，含旧版与当前版） */
var SP_RE = /Sponsored|スポンサー|スポンサー プロダクト|商品推广|Gesponsert|Gesponsord|Sponsorowane|Sponsorlu|Sponzorováno|Sponsorisé|Patrocinado|Sponsorizzato/i;

var CONC = 3 + Math.floor(Math.random() * 3);  // 并发任务数（v1.1.10：3~5 随机，避免固定并发请求模式被识别为爬虫）
var MAX_PAGES = 5;            // 翻页深度上限（默认，可下拉选择，最大 5 页）
var curSite = SITES[0];

var tasks = [], queue = [], active = 0, done = 0, total = 0, stopFlag = false, captchaCount = 0;
var results = [];
var top6Cache = {};      // site.key|kw -> 自然排名 TOP6 [{asin,img}]
var top6AdCache = {};    // site.key|kw -> 广告排名 TOP6 [{asin,img}]

/* ---------------- 工具函数 ---------------- */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function parseHtml(html) {
  try { return $(new DOMParser().parseFromString(html, 'text/html')); }
  catch (e) { return $($.parseHTML(html)); }
}
function isAsinTok(t) { return /^[A-Z0-9]{10}$/.test(t); }
function resolveSite(tok) {
  if (!tok) return curSite;
  var t = String(tok).trim();
  for (var i = 0; i < SITES.length; i++) {
    if (SITES[i].name === t || SITES[i].key === t) return SITES[i];
  }
  return curSite;
}
function fetchText(url, ua, timeout, opt) {
  opt = opt || {};
  var extraHeaders = opt.headers || {};
  /* v1.1.8：根据 UA 选择基础头（移动端头集合更精简），再与调用方自定义头部合并（后者优先） */
  var baseHeaders = /Mobile/.test(ua) ? BASE_HDR_MOBILE : BASE_HDR_PC;
  var headers = {};
  for (var k in baseHeaders) headers[k] = baseHeaders[k];
  for (var k2 in extraHeaders) headers[k2] = extraHeaders[k2];
  return new Promise(function (resolve, reject) {
    $.ajax({
      type: opt.method || 'GET',
      url: url,
      timeout: timeout || 10000,
      cache: false,
      dataType: 'text',
      headers: headers,
      data: opt.body,
      xhrFields: { withCredentials: true },   /* 携带浏览器 cookie（扩展共享） */
      beforeSend: function (xhr) { if (ua) xhr.setRequestHeader('User-Agent', ua); },
      success: resolve,
      error: function (xhr, st) { reject(new Error(st || '网络错误')); }
    });
  });
}
function pad(n) { return n < 10 ? '0' + n : '' + n; }

/* ---------------- 邮编设置（亚马逊 glow 配送地址服务，还原原插件功能） ----------------
 * 三步：取 #glowValidationToken → 取 CSRF_TOKEN → POST address-change 设置邮编。
 * 成功后会更新浏览器内亚马逊的配送地址 cookie，之后搜索请求按该邮编本地化，与浏览器内看到的
 * 结果更一致。只在本轮查询填了邮编时执行（每个站点最多一次），不填则不动浏览器现有地址。
 */
var zipDone = {};   // domain -> true
function setZip(domain, zip) {
  if (!zip || zipDone[domain]) return Promise.resolve();
  zipDone[domain] = true;
  var base = 'https://www.amazon.' + domain;
  return fetchText(base + '/', null, 10000)
    .then(function (html) {
      var token = '';
      try { token = parseHtml(html).find('#glowValidationToken').val() || ''; } catch (e) {}
      return token;
    })
    .then(function (token) {
      return fetchText(base + '/portal-migration/hz/glow/get-rendered-address-selections?deviceType=desktop&pageType=Gateway&storeContext=NoStoreName&actionSource=desktop-modal', null, 10000, {
        headers: { 'x-requested-with': 'XMLHttpRequest', 'accept': 'text/html,*/*', 'anti-csrftoken-a2z': token }
      });
    })
    .then(function (resp) {
      var csrf = '';
      try { csrf = resp.split('CSRF_TOKEN')[1].split('"')[1]; } catch (e) {}
      return csrf;
    })
    .then(function (csrf) {
      if (!csrf) return;
      return fetchText(base + '/portal-migration/hz/glow/address-change?actionSource=glow', null, 10000, {
        method: 'POST',
        headers: {
          'Content-type': 'application/x-www-form-urlencoded',
          'accept': 'text/html,*/*',
          'x-requested-with': 'XMLHttpRequest',
          'anti-csrftoken-a2z': csrf
        },
        body: 'locationType=LOCATION_INPUT&storeContext=sporting-goods&deviceType=web&pageType=Detail&actionSource=glow&almBrandId=undefined&zipCode=' + encodeURIComponent(zip)
      });
    })
    .catch(function () {});
}

/* ---------------- 输入解析（多格式） ---------------- */
/*
  支持格式（每行一组，分隔符：Tab / 空格 / 英文逗号 / 中文逗号 均可）：
  1) ASIN 在前：  ASIN\tKeyword1 / ASIN Keyword1 / ASIN,Keyword1 / ASIN，Keyword1
  2) 一 ASIN 多关键词（关键词之间用逗号分隔）： ASIN\tKeyword1,Keyword2 / ASIN Keyword1，Keyword2
  3) 逗号版：    ASIN,Keyword1,Keyword2
  4) 关键词在前（旧格式兼容）： Keyword1,ASIN
  5) 行首可加站点覆盖： 日本\tASIN\tKeyword1 / 日本，ASIN，Keyword1
  每组 ASIN × 关键词 展开为一条查询任务。
*/
function parseInput(text) {
  var out = [], errs = [];
  var lines = String(text).split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    /* 先按 Tab / 中英文逗号 拆分（关键词之间必须用逗号分隔） */
    var toks = line.split(/[\t,，]+/).map(function (t) { return t.trim(); }).filter(Boolean);
    if (!toks.length) continue;
    var site = curSite;
    if (SITES.some(function (s) { return s.name === toks[0] || s.key === toks[0]; })) {
      site = resolveSite(toks[0]); toks = toks.slice(1);
    }
    if (!toks.length) { errs.push('第 ' + (i + 1) + ' 行未识别出 ASIN：' + line); continue; }
    var asin = null, kws = [];
    var head = toks[0], headU = head.toUpperCase();
    /* 情形A：首段是纯 ASIN */
    if (isAsinTok(headU)) {
      asin = headU; kws = toks.slice(1);
    } else {
      /* 情形B：首段以 ASIN 开头 + 空格 + 第一个关键词（如 "ASIN Keyword1"） */
      var m0 = headU.match(/^([A-Z0-9]{10})(?=\s|$)/);
      if (m0) {
        asin = m0[1];
        var rest = head.slice(m0[1].length).trim();
        kws = rest ? [rest].concat(toks.slice(1)) : toks.slice(1);
      } else if (toks.length >= 2 && isAsinTok(toks[toks.length - 1].toUpperCase())) {
        /* 情形C：关键词在前（旧格式），ASIN 在最后 */
        asin = toks[toks.length - 1].toUpperCase(); kws = toks.slice(0, toks.length - 1);
      } else {
        errs.push('第 ' + (i + 1) + ' 行未识别出 ASIN：' + line);
        continue;
      }
    }
    if (!kws.length) { errs.push('第 ' + (i + 1) + ' 行缺少关键词：' + line); continue; }
    for (var j = 0; j < kws.length; j++) {
      out.push({ site: site, asin: asin, kw: kws[j] });
    }
  }
  return { tasks: out, errs: errs };
}

/* ---------------- 搜索结果解析 ---------------- */
function imgOf($el) {
  var $img = $el.find('img.s-image').first();
  if (!$img.length) return '';
  var src = $img.attr('src') || '';
  if (!src || src.indexOf('data:') === 0) src = $img.attr('data-src') || $img.attr('data-a-hires') || '';
  if (src && src.indexOf('//') === 0) src = 'https:' + src;
  return src;
}
function parseSearchHtml(html, targetAsin) {
  var $d = parseHtml(html);
  var $items = $d.find("[data-component-type='s-search-results'] [data-component-type='s-search-result']");
  if (!$items.length) $items = $d.find("[data-component-type='s-search-result']");
  /* 注意（v1.1.15 明确口径）：只检查 SP 广告。
   * SB 广告（品牌横幅/轮播 "Popular Shopping Ideas"/"From frequently shopped brands"、
   * SBV 品牌视频）位于 .a-carousel-card 轮播容器内，不在 s-search-result 卡片中，
   * 天然不会被本解析器收集——SB 一律不做排名检查，无需额外排除逻辑。 */
  /* pos 口径（v1.1.6 起，与 Helium10/SellerSprite 一致）：
   * 自然位卡片 pos = 自然位专用序号（仅非广告累计，广告不占序号）
   * 广告位卡片 pos = 广告位序号（第 N 个广告位）                  */
  var list = [], organicPos = 0, adPos = 0;
  $items.each(function () {
    var $el = $(this);
    var asin = ($el.attr('data-asin') || '').trim().toUpperCase();
    if (!asin) return;
    /* 广告多维判定（v1.1.7）：文本标签 + 组件类型 + data-ad-id + aria-label + 赞助信息图标，
     * 覆盖 SP 广告的各种渲染形态，避免单一选择器漏判导致广告排名/广告TOP6全空 */
    var sponsored = !!$el.find('.puis-sponsored-label-text, .s-sponsored-label-text, [data-ad-id], [aria-label*="Sponsored"], .sponsored-info-icon, .s-sponsored-info-icon').length
      || $el.attr('data-component-type') === 'sp-sponsored-result'
      || $el.hasClass('AdHolder')   /* v1.1.13 补充：老版广告卡片类名（Lumen-Ads 方案） */
      || SP_RE.test($el.text());
    if (sponsored) adPos++; else organicPos++;
    list.push({ asin: asin, sponsored: sponsored, pos: sponsored ? adPos : organicPos, img: imgOf($el) });
  });
  /* 验证码/拦截检测 */
  var bodyTxt = ($d.find('body').text() || '').toLowerCase();
  if (!list.length && (bodyTxt.indexOf('captcha') > -1 || bodyTxt.indexOf('enter the characters') > -1)) {
    return { natural: null, ad: null, lastPage: 1, top6: [], captcha: true, total: 0, sponsTotal: 0 };
  }
  /* 总页数 */
  var pg = [];
  $d.find('.s-pagination-item, .s-pagination-disabled, .a-pagination .a-link-normal, .a-pagination .a-disabled').each(function () {
    var v = parseInt($(this).text().trim().replace(/[^0-9]/g, ''), 10);
    if (v > 0 && v < 100000) pg.push(v);
  });
  var lastPage = pg.length ? Math.max.apply(null, pg) : 1;
  /* 目标 ASIN 的自然/广告排名 */
  var natural = null, ad = null;
  for (var i = 0; i < list.length; i++) {
    var r = list[i];
    if (r.asin === targetAsin) {
      if (!r.sponsored && natural === null) natural = r.pos;
      if (r.sponsored && ad === null) ad = r.pos;
    }
  }
  /* 自然排名 TOP6（非广告位前 6 个） */
  var top6 = [];
  for (var k = 0; k < list.length && top6.length < 6; k++) {
    if (!list[k].sponsored) top6.push({ asin: list[k].asin, img: list[k].img });
  }
  /* 广告排名 TOP6（广告位前 6 个） */
  var top6Ad = [];
  for (var ka = 0; ka < list.length && top6Ad.length < 6; ka++) {
    if (list[ka].sponsored) top6Ad.push({ asin: list[ka].asin, img: list[ka].img });
  }
  return { natural: natural, ad: ad, lastPage: lastPage, top6: top6, top6Ad: top6Ad, captcha: false, total: list.length, sponsTotal: list.filter(function (x) { return x.sponsored; }).length, targetInResults: list.some(function (x) { return x.asin === targetAsin; }), organicTotal: list.length - list.filter(function (x) { return x.sponsored; }).length, adTotal: list.filter(function (x) { return x.sponsored; }).length };
}

/* ---------------- 单条任务：PC + 移动端搜索 ---------------- */
function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}
/* 亚马逊对连续/高频请求会随机返回"无广告基础版"（无赞助标记、结果 48 项左右）。
 * v1.1.16 浏览器实测：同一 session 同一关键词，请求级随机降级——约半数请求返回基础版
 * （48 项 0 广告），半数返回完整版（60 项 12 广告）；带 Cache-Control:no-cache 概率更高。
 * 基础版判定（v1.1.16 简化，适配"无论目标 ASIN 有无排名都要列出全部广告"的口径）：
 * 1) 0 广告 + 结果≥8 → 疑似基础版，重试
 * 2) 结果 <8 → 异常页，重试
 * 删除旧版"目标 ASIN 不在结果中即重试"：完整版页面下目标不在就是真不在（可能在 5 页后
 * 或无自然排名），重试纯浪费时间；0 广告时已由规则 1 覆盖重试。
 * v1.1.9：重试间隔只在遇到基础版时才慢下来，正常查询保持快速。 */
function isSuspiciousBasic(r, targetAsin) {
  if (!r || r.captcha) return false;
  /* 情形 1：完全没广告（正常完整版 SP 广告 2~16 个） */
  if (r.sponsTotal === 0 && r.total >= 8) return true;
  /* 情形 2：结果数过少（<8 即异常，正常 PC 搜索首页 16+ 项） */
  if (r.total > 0 && r.total < 8) return true;
  return false;
}
function searchPage(task, page, mobile) {
  var url = 'https://www.amazon.' + task.site.domain + '/s?k=' + encodeURIComponent(task.kw) + '&qid=' + Date.now();
  if (page > 1) url += '&page=' + page;   // 第 1 页不带 page 参数，与浏览器一致
  var ua = mobile ? UA_MOBILE : UA_PC;
  return fetchText(url, ua, 10000)
    .then(function (html) {
      var r = parseSearchHtml(html, task.asin);
      if (r.captcha) captchaCount++;
      return r;
    })
    .catch(function () { return { natural: null, ad: null, lastPage: 1, top6: [], captcha: false, total: 0, sponsTotal: 0 }; });
}
function searchAll(task, mobile) {
  var page1 = null;
  var adSoFar = null;   /* 跨页保留最早广告命中：目标可能在第 1 页只有广告位、第 N 页才有自然位 */
  var organicOffset = 0, adOffset = 0;  /* v1.1.13 跨页累计：前面所有页的自然位/广告位总数，翻页命中时加上 */
  function one(p, tries) {
    if (stopFlag) return Promise.resolve({ natural: null, ad: adSoFar, top6: page1 ? page1.top6 : null, top6Ad: page1 ? page1.top6Ad : null });
    return searchPage(task, p, mobile).then(function (r) {
      if (p === 1) {
        page1 = r;
        /* 遇到基础版才重试（v1.1.16：最多 4 次、间隔 5s/10s/15s/20s 递增 + ±25% 随机抖动。
         * 基础版是请求级随机降级，更长间隔才能等到完整版；正常查询不受影响）。 */
        if (tries < 4 && isSuspiciousBasic(r, task.asin)) {
          adSoFar = null; organicOffset = 0; adOffset = 0;
          var base = [5000, 10000, 15000, 20000][tries] || 20000;
          var delay = Math.round(base * (0.75 + Math.random() * 0.5));
          return sleep(delay).then(function () { return one(1, tries + 1); });
        }
      }
      /* 命中当前页：排名 = 前面所有页累计 + 本页页内序号（v1.1.13 修复，对齐 SellerSprite/Helium10 跨页口径） */
      var natural = (r.natural !== null) ? organicOffset + r.natural : null;
      var ad = (r.ad !== null) ? adOffset + r.ad : null;
      if (ad !== null && adSoFar === null) adSoFar = ad;
      var lastPage = Math.min(MAX_PAGES, r.lastPage || 1);
      if (r.captcha) return { natural: null, ad: adSoFar, top6: page1 ? page1.top6 : null, top6Ad: page1 ? page1.top6Ad : null, captcha: true };
      /* v1.1.6：仅自然位命中才算命中并停止翻页；广告位命中不算命中，继续翻页找自然位 */
      if (natural !== null || p >= lastPage) {
        return { natural: natural, ad: adSoFar, top6: page1 ? page1.top6 : null, top6Ad: page1 ? page1.top6Ad : null, captcha: false };
      }
      /* 本页未命中 → 累计本页数量后继续翻页 */
      organicOffset += r.organicTotal || 0;
      adOffset += r.adTotal || 0;
      return one(p + 1, tries);
    });
  }
  return one(1, 0);
}
function execTask(task) {
  /* v1.1.14：任务级失败重试。网络错误/超时/验证码 → 整条任务（PC+移动端）重跑，
   * 最多 3 次、间隔 2s/4s 递增随机——避免单次网络抖动直接记 null 造成排名缺失。
   * 正常请求仍保持随机节奏：间隔 700~2200ms、并发 3~5（每批随机）。 */
  var jitter = 700 + Math.floor(Math.random() * 1500);
  return sleep(jitter).then(function () {
    return runTask(task, 0);
  }).then(function () {
    renderTable(); updateProgress();
  });
}

function runTask(task, attempt) {
  return searchAll(task, false).then(function (pc) {
    if (stopFlag) return;
    /* TOP6 缓存（按 站点+关键词 去重） */
    var tkey = task.site.key + '|' + task.kw;
    if (!top6Cache[tkey] && pc.top6 && pc.top6.length) {
      top6Cache[tkey] = pc.top6;
    }
    if (!top6AdCache[tkey] && pc.top6Ad && pc.top6Ad.length) {
      top6AdCache[tkey] = pc.top6Ad;
    }
    return searchAll(task, true).then(function (mb) {
      if (stopFlag) return;
      results.push({
        site: task.site, asin: task.asin, kw: task.kw,
        nr: pc.natural, ar: pc.ad, nrM: mb.natural, arM: mb.ad
      });
    });
  }).catch(function () {
    if (stopFlag) return;
    /* 3 次尝试（0/1/2）全部失败 → 记 null；否则间隔递增随机后重试整条任务 */
    if (attempt >= 2) {
      results.push({ site: task.site, asin: task.asin, kw: task.kw, nr: null, ar: null, nrM: null, arM: null });
      return;
    }
    var base = attempt === 0 ? 2000 : 4000;
    var delay = base + Math.floor(Math.random() * 1500);
    return sleep(delay).then(function () { return runTask(task, attempt + 1); });
  });
}

/* ---------------- 并发队列 ---------------- */
function pump() {
  while (!stopFlag && active < CONC && queue.length) {
    var job = queue.shift(); active++;
    (function (j) {
      Promise.resolve().then(j.fn).then(function (r) { j.resolve(r); })
        .catch(function () { j.resolve(null); })
        .then(function () { active--; done++; updateProgress(); pump(); });
    })(job);
  }
  if (!queue.length && active === 0 && running) finish();
}
function enqueue(fn) {
  return new Promise(function (resolve) { queue.push({ fn: fn, resolve: resolve }); pump(); });
}

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
var running = false;
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
