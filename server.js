const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const https = require('https');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ============================================================
// 설정 (API 키)
// ============================================================
const CONFIG = {
  NAVER: {
    HOSTNAME: 'api.searchad.naver.com',
    CUSTOMER_ID: '4149053',
    API_KEY: '0100000000e24fc0703ff414c476104aa78bb05fc85f8acab25025776ad757571c52a979ea',
    SECRET_KEY: 'AQAAAACg3ep1x3JYqHIQ+vPZOhuVIRyagkkG068rJnWvPYQsRQ==',
  },
  META: {
    AD_ACCOUNT_ID: 'act_1553430152479829',
    ACCESS_TOKEN: 'EAAtrgEASV5wBREWybKt8ZC4EGiAIFcjCxRGqgy1uRpWCaWh5dyO9fX1ZBd16O7ird0LJpVDHOZB8vCkO1Ez5P4GHWtlSefc40DmOYsD1xSCEZCzigPJIvVxPZCNU7aZB0iZAYQ5ZBnaMXX4Jw8ruN0JV6BlbkZB3eHOSYLeLC2mpHVn3kbstUPWev7PoG8H5lzmEjwQZDZD',
  },
};

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// ============================================================
// 유틸리티
// ============================================================
function formatDt(dt) {
  if (!dt) return '2026-03-01';
  if (dt.includes('-')) return dt;
  return `${dt.substring(0,4)}-${dt.substring(4,6)}-${dt.substring(6,8)}`;
}

function getDatesInRange(startDate, endDate) {
  const dates = [];
  const curr = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');
  while (curr <= end) {
    const y = curr.getFullYear();
    const m = String(curr.getMonth() + 1).padStart(2, '0');
    const d = String(curr.getDate()).padStart(2, '0');
    dates.push(`${y}-${m}-${d}`);
    curr.setDate(curr.getDate() + 1);
  }
  return dates;
}

// ============================================================
// 네이버 API 요청
// ============================================================
function naverRequest(method, apiPath, query = {}) {
  return new Promise((resolve, reject) => {
    const timestamp = String(Date.now());
    const params = new URLSearchParams();

    Object.keys(query).sort().forEach(k => {
      if (query[k] !== undefined && query[k] !== '') {
        params.append(k, query[k]);
      }
    });

    const qs = params.toString() ? '?' + params.toString() : '';
    const fullPath = apiPath + qs;

    // 서명은 순수 경로(apiPath)만 사용 — 쿼리스트링 포함 X
    const signature = crypto
      .createHmac('sha256', CONFIG.NAVER.SECRET_KEY)
      .update(`${timestamp}.${method.toUpperCase()}.${apiPath}`)
      .digest('base64');

    const options = {
      hostname: CONFIG.NAVER.HOSTNAME,
      path: fullPath,
      method: method.toUpperCase(),
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Timestamp': timestamp,
        'X-API-KEY': CONFIG.NAVER.API_KEY,
        'X-Customer': CONFIG.NAVER.CUSTOMER_ID,
        'X-Signature': signature,
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ============================================================
// 메타 API 요청
// ============================================================
function metaRequest(reqPath) {
  return new Promise((resolve, reject) => {
    const options = { hostname: 'graph.facebook.com', path: encodeURI(reqPath), method: 'GET' };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ data: [], error: data }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ============================================================
// 네이버: 행 변환 헬퍼
// ============================================================
function mapNaverRow(entity, stat) {
  const spend = Number(stat.salesAmt) || 0;
  const rev   = Number(stat.convAmt) || 0;
  const clk   = Number(stat.clkCnt) || 0;
  const imp   = Number(stat.impCnt) || 0;
  const cnv   = Number(stat.ccnt) || 0;

  let name = entity.name || '알 수 없음';
  if (entity.ad) name = entity.ad.name || (entity.ad.item && entity.ad.item.title) || name;

  return {
    id: entity.nccCampaignId || entity.nccAdgroupId || entity.nccAdId || 'unknown',
    name, spend, impressions: imp, clicks: clk, conversions: cnv, revenue: rev,
    ctr: imp > 0 ? Number((clk / imp * 100).toFixed(2)) : 0,
    cpc: clk > 0 ? Math.round(spend / clk) : 0,
    cvr: clk > 0 ? Number((cnv / clk * 100).toFixed(2)) : 0,
    roas: spend > 0 ? Number((rev / spend * 100).toFixed(2)) : 0,
    cpa: cnv > 0 ? Math.round(spend / cnv) : 0,
  };
}

// ============================================================
// 네이버 라우트
// ============================================================

// 네이버 일별 요약 (차트용)
app.get('/api/daily-summary', async (req, res) => {
  try {
    const { dateFrom, dateTo, idType, targetId } = req.query;
    const safeFrom = formatDt(dateFrom);
    const safeTo   = formatDt(dateTo);
    const dates = getDatesInRange(safeFrom, safeTo);

    const grouped = {};
    dates.forEach(d => {
      grouped[d] = { date: d, spend: 0, imp: 0, clicks: 0, conv: 0, revenue: 0 };
    });

    let targetIds = [];
    let reqIdType = idType || 'CAMPAIGN';

    if (targetId) {
      targetIds = [targetId];
    } else {
      const campRes = await naverRequest('GET', '/ncc/campaigns');
      if (campRes.status !== 200 || !Array.isArray(campRes.body)) return res.json([]);
      if (campRes.body.length === 0) return res.json([]);
      targetIds = campRes.body.map(c => c.nccCampaignId);
    }

    const idsStr = targetIds.slice(0, 50).join(',');
    console.log(`[네이버 차트] ${dates.length}일 수집 시작`);

    for (const d of dates) {
      const statsRes = await naverRequest('GET', '/stats', {
        idType: reqIdType,
        ids: idsStr,
        fields: JSON.stringify(['impCnt', 'clkCnt', 'salesAmt', 'ccnt', 'convAmt']),
        timeRange: JSON.stringify({ since: d, until: d }),
      });

      if (statsRes.status === 200) {
        const arr = statsRes.body.data || statsRes.body || [];
        if (Array.isArray(arr)) {
          arr.forEach(item => {
            const st = item.stat || item || {};
            grouped[d].spend   += Number(st.salesAmt) || 0;
            grouped[d].imp     += Number(st.impCnt) || 0;
            grouped[d].clicks  += Number(st.clkCnt) || 0;
            grouped[d].conv    += Number(st.ccnt) || 0;
            grouped[d].revenue += Number(st.convAmt) || 0;
          });
        }
      }
      await delay(150);
    }

    const result = Object.values(grouped).map(r => ({
      date_or_name: r.date, platform: 'naver',
      ...r,
      impressions: r.imp, conversions: r.conv, cost: r.spend,
      ctr:  r.imp > 0 ? Number((r.clicks / r.imp * 100).toFixed(2)) : 0,
      cpc:  r.clicks > 0 ? Math.round(r.spend / r.clicks) : 0,
      cvr:  r.clicks > 0 ? Number((r.conv / r.clicks * 100).toFixed(2)) : 0,
      cpa:  r.conv > 0 ? Math.round(r.spend / r.conv) : 0,
      roas: r.spend > 0 ? Number((r.revenue / r.spend * 100).toFixed(2)) : 0,
    })).sort((a, b) => a.date.localeCompare(b.date));

    console.log('[네이버 차트] 완료');
    res.json(result);
  } catch (e) {
    console.error('네이버 차트 에러:', e.message);
    res.json([]);
  }
});

// 네이버 캠페인 목록
app.get('/api/campaign-stats', async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const campRes = await naverRequest('GET', '/ncc/campaigns');
    if (campRes.status !== 200 || !Array.isArray(campRes.body)) return res.json({ rows: [] });
    const campaigns = campRes.body;
    if (!campaigns.length) return res.json({ rows: [] });

    const ids = campaigns.map(c => c.nccCampaignId).slice(0, 50);
    const statsRes = await naverRequest('GET', '/stats', {
      idType: 'CAMPAIGN', ids: ids.join(','),
      fields: JSON.stringify(['impCnt', 'clkCnt', 'salesAmt', 'ccnt', 'convAmt']),
      timeRange: JSON.stringify({ since: formatDt(dateFrom), until: formatDt(dateTo) }),
    });

    const statsMap = {};
    const arr = statsRes.body.data || statsRes.body || [];
    if (Array.isArray(arr)) arr.forEach(i => { statsMap[i.id] = i.stat || i; });

    const rows = campaigns.map(c => mapNaverRow(c, statsMap[c.nccCampaignId] || {}));
    res.json({ rows: rows.sort((a, b) => b.spend - a.spend) });
  } catch (e) {
    console.error('캠페인 에러:', e.message);
    res.json({ rows: [] });
  }
});

// 네이버 광고그룹 목록
app.get('/api/adgroups', async (req, res) => {
  try {
    const { campaignId, dateFrom, dateTo } = req.query;
    if (!campaignId) return res.json({ rows: [] });

    const listRes = await naverRequest('GET', '/ncc/adgroups', { nccCampaignId: campaignId });
    const groups = listRes.body;
    if (!Array.isArray(groups) || !groups.length) return res.json({ rows: [] });

    const ids = groups.map(g => g.nccAdgroupId).slice(0, 50);
    const statsRes = await naverRequest('GET', '/stats', {
      idType: 'ADGROUP', ids: ids.join(','),
      fields: JSON.stringify(['impCnt', 'clkCnt', 'salesAmt', 'ccnt', 'convAmt']),
      timeRange: JSON.stringify({ since: formatDt(dateFrom), until: formatDt(dateTo) }),
    });

    const statsMap = {};
    const arr = statsRes.body.data || statsRes.body || [];
    if (Array.isArray(arr)) arr.forEach(i => { statsMap[i.id] = i.stat || i; });

    const rows = groups.map(g => mapNaverRow(g, statsMap[g.nccAdgroupId] || {}));
    res.json({ rows: rows.sort((a, b) => b.spend - a.spend) });
  } catch (e) { res.json({ rows: [] }); }
});

// 네이버 소재 목록
app.get('/api/ads', async (req, res) => {
  try {
    const { adgroupId, dateFrom, dateTo } = req.query;
    if (!adgroupId) return res.json({ rows: [] });

    const listRes = await naverRequest('GET', '/ncc/ads', { nccAdgroupId: adgroupId });
    const ads = listRes.body;
    if (!Array.isArray(ads) || !ads.length) return res.json({ rows: [] });

    const ids = ads.map(a => a.nccAdId).slice(0, 50);
    const statsRes = await naverRequest('GET', '/stats', {
      idType: 'AD', ids: ids.join(','),
      fields: JSON.stringify(['impCnt', 'clkCnt', 'salesAmt', 'ccnt', 'convAmt']),
      timeRange: JSON.stringify({ since: formatDt(dateFrom), until: formatDt(dateTo) }),
    });

    const statsMap = {};
    const arr = statsRes.body.data || statsRes.body || [];
    if (Array.isArray(arr)) arr.forEach(i => { statsMap[i.id] = i.stat || i; });

    const rows = ads.map(a => mapNaverRow(a, statsMap[a.nccAdId] || {}));
    res.json({ rows: rows.sort((a, b) => b.spend - a.spend) });
  } catch (e) { res.json({ rows: [] }); }
});

// ============================================================
// 메타 라우트
// ============================================================

// 메타 일별 요약 (차트용)
app.get('/api/meta-daily', async (req, res) => {
  try {
    const { since, until, level = 'campaign', parentId } = req.query;
    let filtering = '';
    if (parentId) {
      const filterField = level === 'adset' ? 'campaign.id' : 'adset.id';
      filtering = `&filtering=[{"field":"${filterField}","operator":"EQUAL","value":"${parentId}"}]`;
    }
    const p = `/v19.0/${CONFIG.META.AD_ACCOUNT_ID}/insights?level=${level}${filtering}&fields=spend,inline_link_clicks,purchase_roas,actions&time_range={"since":"${since}","until":"${until}"}&time_increment=1&access_token=${CONFIG.META.ACCESS_TOKEN}`;
    const result = await metaRequest(p);
    res.json(result);
  } catch (e) {
    console.error('메타 일별 에러:', e.message);
    res.json({ data: [] });
  }
});

// 메타 리스트 (테이블용)
app.get('/api/meta-stats', async (req, res) => {
  try {
    const { since, until, level = 'campaign', parentId } = req.query;
    const fields = 'campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,reach,purchase_roas,inline_link_clicks,unique_inline_link_clicks,actions';
    let filtering = '';
    if (parentId) {
      const filterField = level === 'adset' ? 'campaign.id' : 'adset.id';
      filtering = `&filtering=[{"field":"${filterField}","operator":"EQUAL","value":"${parentId}"}]`;
    }
    const p = `/v19.0/${CONFIG.META.AD_ACCOUNT_ID}/insights?level=${level}${filtering}&fields=${fields}&time_range={"since":"${since}","until":"${until}"}&access_token=${CONFIG.META.ACCESS_TOKEN}`;
    const result = await metaRequest(p);
    res.json(result);
  } catch (e) {
    console.error('메타 리스트 에러:', e.message);
    res.json({ data: [] });
  }
});

// ============================================================
// 메인 페이지
// ============================================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'ad-dashboard.html'));
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`\n🚀 통합 대시보드 서버 가동! (포트: ${PORT})`);
  console.log('   네이버 + 메타 API 모두 지원\n');
});
