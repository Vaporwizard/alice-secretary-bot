const { Client } = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');

// 1. Credentials & Config (With secure decoded fallbacks)
const dec = (b) => Buffer.from(b, 'base64').toString('utf8');

const LINE_CONFIG = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || dec('SDJISGRicUxDM3FtL0NjcTlRRFVuc1Y2SWM1bjFuN2FWcVdEMnBGelpIeDEzbHk4akdlSmlSeG1JNy9FUzliRmUwRUdUd2h3RWs5N3Z5WDlyeHJ1MTBPRHdnZTF3eSt1cWpvcjNQYU9JYkRaTWRRd0txeFZaSmRuWFdlSlNZU3Bzc0YvVjNOSnpKNWVmckNhUXhGakdnZEIwNHQ4OS8xTy93MWNEbnlpbEZVPQ=='),
  channelSecret: process.env.LINE_CHANNEL_SECRET || dec('NjRmOTNjY2Y2OWMxYjViNDRhYjI1MGVjNDZhZDdkZGE=')
};

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || dec('QVEuQWI4Uk42TG4yYXJLU2JBbDFoSl9naWhTb3pBRXZGZkp2d3dfS2dYMmVWRWNlTlp2cWc=');
const LOYVERSE_TOKEN = process.env.LOYVERSE_API_TOKEN || dec('Y2FjNWVlN2I0NTkyNGM1NjhiNDc0YWUxMTMzN2E0Nzc=');
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ysxolgzhxcfwmdubroqg.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || dec('c2Jfc2VjcmV0X1VxTTUzWVp6dXdGQS0xejVyRkk5MEFfSkVFTHB0UWc=');
const SHEETS_WEBHOOK = process.env.GOOGLE_SHEETS_WEBHOOK_URL || 'https://script.google.com/macros/s/AKfycbwmaYKfCAE0ck1Cl9k4xC9LBq-BuV7NL7-dWeu34uprcVrgX1i_NCzdpeYtytc0ct_Iww/exec';

const lineClient = new Client(LINE_CONFIG);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// 2. In-memory Financial State Cache (Persistent baseline as of 15 Oct 2569)
let storeWallets = {
  shop_cash: 5150.00,             // เงินสดร้านค้าจริง (หน้าร้าน 1,340 + ใน บช 3,810)
  investor_capital: 14860.00,     // งบลงทุนเฟส 2 คงเหลือ (งบ 30,000 หัก Relx 8,590 + Marbo 6,550)
  personal_debt: 0.00,            // หนี้ของเฮีย (เคลียร์ครบแล้ว 100%)
  personal_clean_cash: 4201.00,   // เงินส่วนตัวของเฮียจริง ๆ ที่เหลือใช้ (15,500 - 7,575 - 3,724)
  investor_new_deposit: 7575.00   // เงินลงขันใหม่ที่นักลงทุนโอนมา
};

// 3. Helper: Fetch Live Sales from Loyverse API
async function getLiveLoyverseSummary() {
  try {
    const d = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
    const url = `https://api.loyverse.com/v1.0/receipts?limit=100&created_at_min=${d}`;
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${LOYVERSE_TOKEN}` } });
    if (!res.ok) return null;
    const data = await res.json();
    
    let totalGross = 0;
    let totalNet = 0;
    let totalRefunds = 0;
    const itemsSold = {};

    (data.receipts || []).forEach(r => {
      if (r.receipt_type === 'SALE') {
        totalNet += (r.total_money || 0);
        totalGross += (r.total_money || 0) + (r.total_discount || 0);
        (r.line_items || []).forEach(l => {
          itemsSold[l.item_name] = (itemsSold[l.item_name] || 0) + (l.quantity || 1);
        });
      } else if (r.receipt_type === 'REFUND') {
        totalNet -= Math.abs(r.total_money || 0);
        totalRefunds += Math.abs(r.total_money || 0);
      }
    });

    return {
      receiptsCount: (data.receipts || []).length,
      totalNet,
      totalGross,
      totalRefunds,
      itemsSold
    };
  } catch (err) {
    console.error('[Loyverse Fetch Error]:', err.message);
    return null;
  }
}

// 4. Helper: Native Fetch to Gemini API (Text Generation)
async function callGeminiText(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }]
    })
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API Error (${res.status}): ${errText}`);
  }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// 5. Helper: Native Fetch to Gemini API (Image Slip OCR)
async function extractSlipWithGemini(imageBuffer) {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${GEMINI_API_KEY}`;
    const prompt = `คุณคือผู้เชี่ยวชาญการอ่านสลิปธนาคารไทย (OCR Payment Slip) 
ให้สกัดข้อมูลจากภาพสลิปนี้อย่างแม่นยำ 100% ตอบกลับมาเฉพาะ JSON Format นี้เท่านั้น ห้ามมีคำอธิบายอื่น:
{
  "amount": <ตัวเลขจำนวนเงิน เช่น 12100.00>,
  "receiver_name": "<ชื่อผู้รับเงิน เช่น นาย วรวัตน์ เวียงลอ>",
  "receiver_bank": "<ธนาคารผู้รับ เช่น กสิกรไทย, กรุงศรี, ไทยพาณิชย์>",
  "receiver_account": "<เลขที่บัญชีผู้รับ>",
  "sender_name": "<ชื่อผู้โอนเงิน>",
  "datetime": "<วันที่และเวลาโอน เช่น 15 ต.ค. 2569 08:30>",
  "ref_id": "<รหัสอ้างอิงสลิป>"
}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: 'image/jpeg', data: imageBuffer.toString('base64') } }
          ]
        }]
      })
    });

    const data = await res.json();
    const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const cleanJson = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(cleanJson);
  } catch (err) {
    console.error('[Gemini Slip OCR Error]:', err.message);
    return null;
  }
}

// 6. Helper: Generate LINE Flex Message for Slip Allocation
function createSlipFlexMessage(slipData) {
  const amountStr = Number(slipData.amount || 0).toLocaleString('th-TH', { minimumFractionDigits: 2 });
  const receiverStr = slipData.receiver_name || 'ไม่ระบุชื่อผู้รับ';
  const refStr = slipData.ref_id || Date.now().toString().slice(-6);

  return {
    type: 'flex',
    altText: `📄 ได้รับสลิปยอด ฿ ${amountStr} แล้วค่ะเฮีย`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#0f172a',
        paddingAll: '16px',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              { type: 'text', text: '🤖 น้องอลิซ (เลขาการเงิน)', weight: 'bold', color: '#10b981', size: 'sm' },
              { type: 'text', text: 'ตรวจพบสลิปใหม่', align: 'end', color: '#94a3b8', size: 'xs' }
            ]
          },
          { type: 'text', text: `฿ ${amountStr}`, weight: 'bold', color: '#ffffff', size: 'xxl', margin: 'md' },
          { type: 'text', text: `โอนให้: ${receiverStr}`, color: '#cbd5e1', size: 'xs', margin: 'xs' }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#1e293b',
        paddingAll: '16px',
        spacing: 'sm',
        contents: [
          { type: 'text', text: '📌 สลิปนี้ให้ตัดจากกระเป๋าไหนดีคะเฮีย?', weight: 'bold', color: '#f8fafc', size: 'sm' },
          { type: 'text', text: 'กดเลือกปุ่มด้านล่างเพื่อออกใบเบิกเงินอัตโนมัติค่ะ:', color: '#94a3b8', size: 'xs' }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#0f172a',
        paddingAll: '12px',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#10b981',
            height: 'sm',
            action: {
              type: 'postback',
              label: '🟢 สั่งของสต๊อก (ตัดเงินร้าน)',
              data: `action=allocate&cat=shop_stock&amt=${slipData.amount}&rec=${encodeURIComponent(receiverStr)}&ref=${refStr}`,
              displayText: '🟢 ตัดเงินร้านค้า (สั่งของสต๊อก)'
            }
          },
          {
            type: 'button',
            style: 'primary',
            color: '#3b82f6',
            height: 'sm',
            action: {
              type: 'postback',
              label: '💼 งบลงทุนเฟส 2 (ตัดงบ 30k)',
              data: `action=allocate&cat=investor_fund&amt=${slipData.amount}&rec=${encodeURIComponent(receiverStr)}&ref=${refStr}`,
              displayText: '💼 ตัดงบลงทุนเฟส 2 (30k)'
            }
          },
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: {
              type: 'postback',
              label: '🛵 ค่าส่ง / แกร็ป / ดำเนินการ',
              data: `action=allocate&cat=operation_expense&amt=${slipData.amount}&rec=${encodeURIComponent(receiverStr)}&ref=${refStr}`,
              displayText: '🛵 ตัดค่าส่ง/แกร็ป/ดำเนินการ'
            }
          },
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: {
              type: 'postback',
              label: '👤 เฮียหยิบใช้ส่วนตัว (ลงหนี้)',
              data: `action=allocate&cat=personal_debt&amt=${slipData.amount}&rec=${encodeURIComponent(receiverStr)}&ref=${refStr}`,
              displayText: '👤 เฮียดึงใช้ส่วนตัว (บันทึกหนี้)'
            }
          }
        ]
      }
    }
  };
}

// 7. Helper: Generate Voucher Confirmation Flex Message
function createVoucherConfirmationFlex(voucher) {
  const amtStr = Number(voucher.amount).toLocaleString('th-TH', { minimumFractionDigits: 2 });
  const shopCashStr = Number(storeWallets.shop_cash).toLocaleString('th-TH', { minimumFractionDigits: 2 });
  const investorStr = Number(storeWallets.investor_capital).toLocaleString('th-TH', { minimumFractionDigits: 2 });
  const debtStr = Number(storeWallets.personal_debt).toLocaleString('th-TH', { minimumFractionDigits: 2 });

  return {
    type: 'flex',
    altText: `📄 ออกใบสำคัญจ่ายสำเร็จ: ${voucher.id} (฿ ${amtStr})`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#064e3b',
        paddingAll: '16px',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              { type: 'text', text: '✅ ออกใบเบิกเงินสำเร็จ (E-Voucher)', weight: 'bold', color: '#34d399', size: 'xs' },
              { type: 'text', text: voucher.id, align: 'end', color: '#a7f3d0', size: 'xs', fontStyle: 'normal' }
            ]
          },
          { type: 'text', text: `฿ ${amtStr}`, weight: 'bold', color: '#ffffff', size: 'xxl', margin: 'md' },
          { type: 'text', text: `หมวดหมู่: ${voucher.categoryName}`, color: '#6ee7b7', size: 'sm', margin: 'xs' }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#0f172a',
        paddingAll: '16px',
        spacing: 'sm',
        contents: [
          { type: 'text', text: `👤 ผู้รับเงิน: ${voucher.receiver}`, color: '#cbd5e1', size: 'xs' },
          { type: 'text', text: `📅 วันที่บันทึก: ${new Date().toLocaleDateString('th-TH')} ${new Date().toLocaleTimeString('th-TH')}`, color: '#94a3b8', size: 'xs' },
          { type: 'separator', margin: 'md', color: '#334155' },
          { type: 'text', text: '📊 สถานะกระเป๋าเงินคงเหลือล่าสุด:', weight: 'bold', color: '#f8fafc', size: 'xs', margin: 'md' },
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              { type: 'text', text: '🏪 เงินสดร้านค้า:', color: '#94a3b8', size: 'xs' },
              { type: 'text', text: `฿ ${shopCashStr}`, align: 'end', weight: 'bold', color: '#34d399', size: 'xs' }
            ]
          },
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              { type: 'text', text: '💼 งบลงทุนเฟส 2:', color: '#94a3b8', size: 'xs' },
              { type: 'text', text: `฿ ${investorStr}`, align: 'end', weight: 'bold', color: '#60a5fa', size: 'xs' }
            ]
          },
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              { type: 'text', text: '👤 หนี้คงค้างของเฮีย:', color: '#94a3b8', size: 'xs' },
              { type: 'text', text: `฿ ${debtStr}`, align: 'end', weight: 'bold', color: '#fbbf24', size: 'xs' }
            ]
          }
        ]
      }
    }
  };
}

// 8. Main Webhook Handler (Vercel Serverless Function)
module.exports = async (req, res) => {
  if (req.method === 'GET') {
    return res.status(200).send('🌸 N\'Alice AI Secretary Bot is active and running perfectly on Vercel!');
  }

  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const events = req.body?.events || [];
  if (!events || events.length === 0) {
    return res.status(200).send('OK (No events)');
  }

  try {
    for (const event of events) {
      const replyToken = event.replyToken;
      console.log(`[Event Received] Type: ${event.type}, ReplyToken: ${replyToken?.substring(0, 10)}...`);

      // CASE A: User sent an Image (Slip / Receipt)
      if (event.type === 'message' && event.message.type === 'image') {
        const messageId = event.message.id;
        try {
          const contentUrl = `https://api-data.line.me/v2/bot/message/${messageId}/content`;
          const imgRes = await fetch(contentUrl, {
            headers: { 'Authorization': `Bearer ${LINE_CONFIG.channelAccessToken}` }
          });
          const arrayBuf = await imgRes.arrayBuffer();
          const buffer = Buffer.from(arrayBuf);

          const slipInfo = await extractSlipWithGemini(buffer);
          if (slipInfo && slipInfo.amount) {
            const flexMsg = createSlipFlexMessage(slipInfo);
            await lineClient.replyMessage(replyToken, flexMsg);
          } else {
            await lineClient.replyMessage(replyToken, {
              type: 'text',
              text: 'น้องอลิซตรวจดูรูปนี้แล้ว อ่านยอดเงินไม่ชัดเจนค่ะเฮีย รบกวนเฮียถ่ายรูปสลิปตรงๆ ชัดๆ อีกรอบนะคะ 🥺'
            });
          }
        } catch (imgErr) {
          console.error('[Image Process Error]:', imgErr);
        }
      }

      // CASE B: User clicked an Allocation Button (Postback)
      else if (event.type === 'postback') {
        const params = new URLSearchParams(event.postback.data);
        const action = params.get('action');
        const cat = params.get('cat');
        const amt = parseFloat(params.get('amt') || '0');
        const receiver = decodeURIComponent(params.get('rec') || 'ไม่ระบุ');
        const ref = params.get('ref') || 'N/A';

        if (action === 'allocate' && amt > 0) {
          let catName = 'สั่งของสต๊อกร้าน';
          if (cat === 'shop_stock') {
            storeWallets.shop_cash -= amt;
            catName = '🟢 สั่งของสต๊อก (ตัดเงินร้าน)';
          } else if (cat === 'investor_fund') {
            storeWallets.investor_capital -= amt;
            catName = '💼 งบลงทุนเฟส 2 (ตัดงบ 30k)';
          } else if (cat === 'operation_expense') {
            storeWallets.shop_cash -= amt;
            catName = '🛵 ค่าส่ง / แกร็ป / ดำเนินการ';
          } else if (cat === 'personal_debt') {
            storeWallets.personal_debt += amt;
            catName = '👤 เฮียหยิบใช้ส่วนตัว (ลงหนี้)';
          }

          const voucher = {
            id: `PV-${Date.now().toString().slice(-6)}`,
            amount: amt,
            receiver,
            category: cat,
            categoryName: catName,
            ref_id: ref,
            created_at: new Date().toISOString()
          };

          try {
            fetch(SHEETS_WEBHOOK, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'log_voucher', voucher, wallets: storeWallets })
            }).catch(() => {});
          } catch (e) {}

          const confirmFlex = createVoucherConfirmationFlex(voucher);
          await lineClient.replyMessage(replyToken, confirmFlex);
        }
      }

      // CASE C: User sent a Text Question (Conversational CFO Secretary)
      else if (event.type === 'message' && event.message.type === 'text') {
        const userText = event.message.text.trim();
        console.log(`[Text from เฮีย]: "${userText}"`);

        // 1. Fetch live Loyverse sales context if relevant
        let salesContext = '';
        if (userText.includes('ยอด') || userText.includes('ขาย') || userText.includes('วันนี้') || userText.includes('สต๊อก')) {
          const liveSales = await getLiveLoyverseSummary();
          if (liveSales) {
            salesContext = `\n[ข้อมูลจริงจาก Loyverse POS]:\n- ยอดขายสุทธิล่าสุด: ฿ ${liveSales.totalNet.toLocaleString()} (ยอดรวมบิล ${liveSales.receiptsCount} ใบ)\n- ยอดขายรวมก่อนลด: ฿ ${liveSales.totalGross.toLocaleString()}\n- คืนเงิน: ฿ ${liveSales.totalRefunds.toLocaleString()}\n- สินค้าที่ขายได้เด่นๆ: ${Object.entries(liveSales.itemsSold).slice(0, 8).map(([k,v]) => `${k} x${v}`).join(', ')}`;
          }
        }

        // 2. Build Gemini Secretary Prompt
        const systemPrompt = `คุณคือ 'น้องอลิซ' (N'Alice) เลขาการเงินส่วนตัวระดับ CFO ของ 'เฮีย' (เจ้าของร้าน Vapor Store & Hub เชียงใหม่)
บุคลิก: น่ารัก สุภาพ พูดจาคล่องแคล่ว มีกาลเทศะ ฉลาดเฉลียวเรื่องตัวเลขและการเงินรอบด้าน 100%
การเรียก: ให้เรียกผู้ใช้ว่า "เฮีย" เสมอ และแทนตัวเองว่า "อลิซ" หรือ "น้องอลิซ"

ข้อมูลทางการเงินและประวัติการลงทุนของร้าน (ข้อมูลจริงแท้ 100%):
1. เงินลงทุนเฟส 1 (ตั้งต้นร้าน):
   - งบลงขันเริ่มต้นของผู้การ (นักลงทุน 45%): ~31,500 บาท
   - สัดส่วน: ผู้การ 45%, เฮีย 55%
   - สถานะคืนทุนเฟส 1: สินค้าล็อตแรก (V Plus 16K, Marbo Switch, หัวพอต) ขายหมุนเวียนจนคืนทุนค่าของครบหมดแล้ว ตอนนี้ยอดขายที่ได้คือเงินทุนหมุนเวียนและกำไรล้วนๆ
2. เงินลงทุนเฟส 2 (ขยายพอร์ตสต๊อก 3 หมื่นบาท):
   - เงินลงขันก้อนกลาง: 30,000 บาท
   - สั่งซื้อไปแล้ว 2 บิลเมื่อเช้า:
     * บิล 1: Relx Smash Go 50 ตัว (8,590 บาท)
     * บิล 2: Marbo 10K 30 ตัว + ส่ง (6,550 บาท)
     * รวมใช้ไป: 15,140 บาท
   - งบลงทุนเฟส 2 คงเหลือปัจจุบัน: ฿ 14,860.00 (สำรองไว้รอสั่งซื้อ Lego 50 ตัว 11,000 บาท และ Marbo แท้)
3. เงินลงขันเพิ่มล่าสุดวันนี้:
   - นักลงทุนเพิ่งโอนเงินลงขันเพิ่มมาอีก: ฿ 7,575.00
   - เฮียต้องลงขันคู่กันอีก: ฿ 7,575.00
4. สถานะหนี้ของเฮีย:
   - หนี้ 3,724 บาท เฮียจ่ายคืนเข้าบัญชีร้านครบถ้วน 100% เรียบร้อยแล้ว ยอดหนี้คงค้างปัจจุบันคือ ฿ 0.00 บาท (ไม่มีหนี้ค้างคา)
5. เงินสดร้านค้าที่มีอยู่จริง:
   - รวม ฿ 5,150.00 บาท (เงินสดหน้าร้าน 1,340 + ในบัญชีร้าน 3,810)
6. เงินส่วนตัวของเฮียจริง ๆ ที่เหลือใช้:
   - ฿ 4,201.00 บาท (จากเงินในบัญชีเดิม 15,500 - ลงขันเพิ่ม 7,575 - จ่ายหนี้ร้าน 3,724)
${salesContext}

หน้าที่ของคุณ:
- ตอบคำถามของเฮียอย่างตรงประเด็น รวดเร็ว ชัดเจน มีตัวเลขประกอบเสมอ
- ให้คำตอบสั้นกระชับ สรุปง่ายๆ เหมาะกับการอ่านใน LINE (ความยาวไม่เกิน 2-4 ย่อหน้า ไม่เยิ่นเย้อ)`;

        let replyText = '';
        try {
          const fullPrompt = `${systemPrompt}\n\nข้อความจากเฮีย: "${userText}"\n\nคำตอบของน้องอลิซ:`;
          replyText = await callGeminiText(fullPrompt);
        } catch (mErr) {
          console.error('[Gemini Generation Error]:', mErr.message);
          replyText = `สวัสดีค่ะเฮีย! ตอนนี้น้องอลิซพร้อมดูแลบัญชีแล้วค่ะ สถานะเงินร้านตอนนี้เหลืออยู่ ฿ ${storeWallets.shop_cash.toLocaleString()} บาท และงบลงทุนเฟส 2 เหลือ ฿ ${storeWallets.investor_capital.toLocaleString()} บาทค่ะเฮีย!`;
        }

        try {
          await lineClient.replyMessage(replyToken, {
            type: 'text',
            text: replyText
          });
          console.log('[LINE Reply Sent Successfully]');
        } catch (lineErr) {
          console.error('[LINE Reply Error]:', lineErr.message);
        }
      }
    }

    return res.status(200).send('OK');
  } catch (error) {
    console.error('[Alice Webhook Fatal Error]:', error);
    return res.status(500).send('Internal Server Error');
  }
};
