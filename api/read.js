const OpenAI = require("openai");

const client = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});

const MODEL = "gpt-5.4-mini";

const CARDS = [
{ id: 0, name: "The Fool", file: "fool.jpg", meaning: "การเริ่มต้น การก้าวออกจากสิ่งเดิม ความเสี่ยง ความเป็นไปได้" },
{ id: 1, name: "The Magician", file: "magician.jpg", meaning: "เจตจำนง ความสามารถ การลงมือทำ การใช้สิ่งที่มีอยู่ให้เกิดผล" },
{ id: 2, name: "The High Priestess", file: "priestess.jpg", meaning: "สิ่งที่ยังไม่เปิดเผย สัญชาตญาณ ความเงียบ ความจริงที่ต้องรอให้ปรากฏ" },
{ id: 3, name: "The Empress", file: "empress.jpg", meaning: "การเติบโต การหล่อเลี้ยง ความอุดมสมบูรณ์ สิ่งที่กำลังก่อตัว" },
{ id: 4, name: "The Emperor", file: "emperor.jpg", meaning: "โครงสร้าง การควบคุม ความรับผิดชอบ ความมั่นคง" },
{ id: 5, name: "The Hierophant", file: "hierophant.jpg", meaning: "กฎ ระบบ ความเชื่อ คำแนะนำ สิ่งที่มีแบบแผน" },
{ id: 6, name: "The Lovers", file: "lovers.jpg", meaning: "ทางเลือก ความสัมพันธ์ การตัดสินใจ สิ่งที่ต้องเลือกด้วยใจและความจริง" },
{ id: 7, name: "The Chariot", file: "chariot.jpg", meaning: "การเคลื่อนไหว ความมุ่งมั่น การควบคุมทิศทาง การเดินหน้า" },
{ id: 8, name: "Strength", file: "strength.jpg", meaning: "ความเข้มแข็ง การควบคุมอารมณ์ ความอดทน พลังภายใน" },
{ id: 9, name: "The Hermit", file: "hermit.jpg", meaning: "การถอยกลับ การค้นหาคำตอบภายใน ความชัดเจน ความเงียบ" },
{ id: 10, name: "Wheel of Fortune", file: "wheel.jpg", meaning: "การเปลี่ยนแปลง วัฏจักร จุดเปลี่ยน จังหวะที่กำลังเคลื่อน" },
{ id: 11, name: "Justice", file: "justice.jpg", meaning: "ความจริง ความสมดุล ผลจากการตัดสินใจ ความชัดเจน" },
{ id: 12, name: "The Hanged Man", file: "hanged.jpg", meaning: "การหยุดรอ มุมมองใหม่ การปล่อยบางอย่าง การเปลี่ยนวิธีมอง" },
{ id: 13, name: "Death", file: "death.jpg", meaning: "การสิ้นสุด การเปลี่ยนผ่าน การตัดของเดิมเพื่อเข้าสู่สิ่งใหม่" },
{ id: 14, name: "Temperance", file: "temperance.jpg", meaning: "การปรับสมดุล การค่อยเป็นค่อยไป การประสานสิ่งต่าง ๆ ให้ลงตัว" },
{ id: 15, name: "The Devil", file: "devil.jpg", meaning: "พันธะ ความยึดติด แรงดึงดูด รูปแบบที่หลุดออกได้ยาก" },
{ id: 16, name: "The Tower", file: "tower.jpg", meaning: "การเปลี่ยนแปลงฉับพลัน ความจริงที่เปิดออก การพังของสิ่งที่ไม่มั่นคง" },
{ id: 17, name: "The Star", file: "star.jpg", meaning: "ความหวัง การฟื้นตัว ความเชื่อในอนาคต ความสงบหลังความวุ่นวาย" },
{ id: 18, name: "The Moon", file: "moon.jpg", meaning: "ความไม่แน่ใจ สิ่งที่ยังมองไม่ชัด ความกลัว ภาพที่ยังไม่ครบ" },
{ id: 19, name: "The Sun", file: "sun.jpg", meaning: "ความชัดเจน การเปิดเผย ความสำเร็จ พลังชีวิต" },
{ id: 20, name: "Judgement", file: "judgement.jpg", meaning: "การตระหนักรู้ การตัดสินใจ การกลับมาของเรื่องเดิม การเรียกให้เลือก" },
{ id: 21, name: "The World", file: "world.jpg", meaning: "การจบวงจร ความสมบูรณ์ การปิดบทหนึ่งและเข้าสู่อีกบท" }
];

const IMAGE_BASE =
"https://raw.githubusercontent.com/oneera1991-cyber/stillwater-ceremony/main/cards/web/";

function pickCard() {
return CARDS[Math.floor(Math.random() * CARDS.length)];
}

function extractJSON(text) {
try {
return JSON.parse(text);
} catch {}

const match = text.match(/{[\s\S]*}/);

if (!match) {
throw new Error("AI returned invalid JSON");
}

return JSON.parse(match[0]);
}

/*

1. QUESTION ANALYSIS
   ====================================================
   หน้าที่ของส่วนนี้คือ "เข้าใจคนถาม"
   ไม่ใช่เอาคำตอบมาพูดซ้ำใน Reading
   */

const ANALYZER_INSTRUCTIONS = `
คุณคือระบบวิเคราะห์คำถามภายในของ Stillwater

หน้าที่ของคุณคืออ่านคำถามของผู้ใช้แล้วสรุป "แก่นที่จำเป็น"
เพื่อส่งต่อให้ Vera ใช้เป็นบริบทในการอ่านไพ่

ห้ามทำนาย
ห้ามเลือกไพ่
ห้ามให้คำแนะนำชีวิต
ห้ามเขียนคำตอบให้ผู้ใช้

ตอบเป็น JSON เท่านั้น:

{
"intent": "",
"emotional_state": "",
"situation": "",
"core_need": "",
"reading_angle": "",
"key_signals": []
}

กฎ:

- เขียนสั้นมาก
- ใช้ภาษาไทย
- อย่าขยายคำถาม
- อย่าเพิ่มเรื่องที่ผู้ใช้ไม่ได้ถาม
- emotional_state ต้องสะท้อนอารมณ์จริงของคำถาม
- situation ต้องยึดเฉพาะสิ่งที่ผู้ใช้พูด
- reading_angle คือมุมที่ไพ่ควรถูกอ่านกับคำถามนี้
- key_signals มีเพียง 3-5 สัญญาณสำคัญ
  `;

/*

2. VERA READING
   ====================================================
   นี่คือหัวใจของระบบ

หลักสำคัญ:
CARD > QUESTION > ANALYSIS

ไพ่ต้องเป็นพระเอก
คำถามเป็นบริบท
Analysis เป็นเพียงข้อมูลช่วย

ห้ามกลายเป็น ChatGPT ให้คำปรึกษาชีวิต
*/

const READER_INSTRUCTIONS = `
คุณคือ "พี่เวรา" แห่ง Stillwater

คุณกำลังเปิดไพ่ Major Arcana 1 ใบให้คนหนึ่งคน
และต้องพูดกับเขาโดยตรง

เป้าหมายของ Free Reading:
ทำให้คนอ่านรู้สึกว่า
"ไพ่ใบนี้กำลังพูดถึงสิ่งที่ฉันกำลังเจอจริง ๆ"

ไม่ใช่เป้าหมายในการอธิบายไพ่ทั้งหมด
ไม่ใช่บทความ
ไม่ใช่การให้คำปรึกษาชีวิต
ไม่ใช่การปลอบใจ
และไม่ใช่การทำนายอนาคตแบบฟันธง

========================================
ลำดับความสำคัญ

1. ความหมายของไพ่ใบนี้
2. สิ่งที่ไพ่กำลังชี้เมื่อวางกับคำถามนี้
3. อารมณ์หรือแรงตึงที่อยู่ในคำถาม
4. สิ่งหนึ่งที่ยังไม่ชัดหรือควรจับตา

ไพ่ต้องเป็นตัวนำเสมอ

========================================
กฎความยาว

เขียนประมาณ 120-180 คำภาษาไทย

ห้ามเกิน 220 คำโดยเด็ดขาด

ใช้ประมาณ 3 ย่อหน้าสั้น ๆ

ไม่ต้องมีหัวข้อ
ไม่ต้องใส่ bullet
ไม่ต้องสรุปท้ายยาว ๆ

========================================
กฎสำคัญมาก

ห้าม:

- อธิบายความหมายไพ่แบบตำรา
- เล่าความหมายไพ่หลายด้าน
- วิเคราะห์ชีวิตผู้ใช้เป็นบทความ
- ให้คำแนะนำทั่วไปยาว ๆ
- พูดเรื่องที่ไม่เกี่ยวกับคำถาม
- เติมเรื่องเงิน ความรัก งาน สุขภาพ ถ้าผู้ใช้ไม่ได้ถาม
- ใช้คำว่า "คุณควร" ซ้ำ ๆ
- สร้างเหตุการณ์หรือข้อมูลที่ผู้ใช้ไม่ได้ให้
- ระบุวันที่ เดือน หรือจำนวนเงินที่ไพ่ไม่ได้บอก
- รับประกันอนาคต
- พูดว่ารู้ความคิดของบุคคลอื่น
- พยายามทำให้ผู้ใช้สบายใจด้วยคำพูดที่ไม่มีฐานจากไพ่
- จบด้วยคำแนะนำชีวิตยาว ๆ

========================================
สิ่งที่ต้องมี

ย่อหน้าแรก:
พูดถึง "พลังหลักของไพ่" ที่กำลังแตะคำถามนี้
ให้เข้าเรื่องทันที

ย่อหน้าที่สอง:
เชื่อมไพ่เข้ากับสถานการณ์ของผู้ถามโดยตรง
ต้องมีรายละเอียดจากไพ่ที่ชัดเจน
เช่น:
การเคลื่อนไหว
การหยุด
การรอ
การถอย
การกลับมา
การเปลี่ยนผ่าน
ความชัดเจน
สิ่งที่ซ่อนอยู่
ทางเลือก
จุดเปลี่ยน
โอกาส
อุปสรรค

เลือกเฉพาะสิ่งที่ตรงกับไพ่
อย่ายัดทุกอย่างเข้าไป

ย่อหน้าสุดท้าย:
ให้ "หนึ่งประเด็นที่น่าจับตา"
หรือ "หนึ่งสิ่งที่ไพ่ยังไม่ได้เปิดออกทั้งหมด"

ต้องเหลือพื้นที่ให้ผู้ใช้รู้สึกว่า
ยังมีบางอย่างที่อยากรู้ต่อ

========================================
น้ำเสียงของพี่เวรา

นิ่ง
ตรง
อบอุ่นแบบไม่ประดิษฐ์
มีความมั่นใจ
ไม่หวานเกินไป
ไม่ลึกลับจนอ่านไม่รู้เรื่อง
ไม่พูดเหมือนนักบำบัด
ไม่พูดเหมือน AI

พูดเหมือนผู้หญิงคนหนึ่งที่กำลังมองไพ่ตรงหน้า
แล้วบอกสิ่งที่เห็นอย่างตรงไปตรงมา

========================================
หลักสำคัญที่สุด

อย่าใช้จำนวนคำเพื่อแสดงว่าคุณเก่ง

ทุกประโยคต้องทำอย่างใดอย่างหนึ่ง:

- บอกสิ่งที่ไพ่ชี้
- เชื่อมไพ่กับคำถาม
- เปิดประเด็นที่น่าจับตา

ถ้าประโยคไหนไม่ทำหน้าที่เหล่านี้ ให้ตัดออก

หากคำถามถามว่า "เมื่อไหร่"
อย่าคิดวันที่ขึ้นมาเอง
ให้ตอบเรื่อง "จังหวะ" หรือ "เงื่อนไขของการเปลี่ยนแปลง"
ตามที่ไพ่รองรับเท่านั้น

หากไพ่ไม่สนับสนุนคำตอบที่ผู้ถามอยากได้
ให้พูดตรง ๆ อย่างนุ่มนวล

อย่าพยายามทำให้ทุกคำตอบเป็นบวก
ไพ่ทุกใบมีทั้งแรงส่งและแรงตึง
`;

async function main(req, res) {
if (req.method !== "POST") {
return res.status(405).json({
error: "Method not allowed"
});
}

try {
const { question } = req.body || {};

if (!question || !question.trim()) {
  return res.status(400).json({
    error: "กรุณาพิมพ์คำถามก่อน"
  });
}

if (!process.env.OPENAI_API_KEY) {
  return res.status(500).json({
    error: "OPENAI_API_KEY is missing"
  });
}

/*
----------------------------------------
STEP 1: วิเคราะห์คำถาม
----------------------------------------
*/

const analysisResponse = await client.responses.create({
  model: MODEL,
  instructions: ANALYZER_INSTRUCTIONS,
  input: `คำถามของผู้ใช้:\n${question.trim()}`,
  max_output_tokens: 220
});

const analysisText = analysisResponse.output_text || "";
const analysis = extractJSON(analysisText);

/*
----------------------------------------
STEP 2: สุ่มไพ่
----------------------------------------
*/

const card = pickCard();

/*
----------------------------------------
STEP 3: Vera อ่านไพ่
----------------------------------------
*/

const readerInput = `

คำถามของผู้ใช้:
${question.trim()}

ข้อมูลวิเคราะห์ภายใน:
${JSON.stringify(analysis, null, 2)}

ไพ่ที่เปิดได้:
${card.name}

ความหมายหลักของไพ่:
${card.meaning}

โปรดอ่านไพ่ใบนี้กับคำถามนี้โดยตรง

จำไว้:

- ไพ่คือพระเอก

- อย่าพูดนอกไพ่

- อย่าให้คำแนะนำชีวิตยาว

- อย่าอธิบายทุกความหมายของไพ่

- ให้ 1 insight ที่คม

- ให้ 1 จุดที่ยังน่าติดตาม

- จบก่อนที่จะพูดซ้ำ
  `;
  
  const readingResponse = await client.responses.create({
  model: MODEL,
  instructions: READER_INSTRUCTIONS,
  input: readerInput,
  max_output_tokens: 300
  });
  
  const reading = (readingResponse.output_text || "").trim();
  
  /*
  
  TOKEN / COST
  
  */
  
  const analysisUsage = analysisResponse.usage || {};
  const readingUsage = readingResponse.usage || {};
  
  const analysisInput =
  analysisUsage.input_tokens || 0;
  
  const analysisOutput =
  analysisUsage.output_tokens || 0;
  
  const readingInput =
  readingUsage.input_tokens || 0;
  
  const readingOutput =
  readingUsage.output_tokens || 0;
  
  const totalInput =
  analysisInput + readingInput;
  
  const totalOutput =
  analysisOutput + readingOutput;
  
  /*
  ราคานี้ใช้สำหรับแสดงต้นทุนทดสอบภายในเท่านั้น
  ไม่เกี่ยวกับราคาขายให้ลูกค้า
  */
  
  const INPUT_PRICE_PER_MILLION = 0.75;
  const OUTPUT_PRICE_PER_MILLION = 4.50;
  
  const estimatedCost =
  (totalInput / 1000000) * INPUT_PRICE_PER_MILLION +
  (totalOutput / 1000000) * OUTPUT_PRICE_PER_MILLION;
  
  /*
  
  RESPONSE
  
  */
  
  // Flatten usage fields for existing index.html display
  return res.status(200).json({
  success: true,
  
  question: question.trim(),

analysis: {
  ...analysis,
  emotional_intensity: analysis.emotional_intensity || analysis.emotional_state || ""
},

card: {
  id: card.id,
  name: card.name,
  file: card.file,
  image: IMAGE_BASE + card.file,
  meaning: card.meaning
},

reading,

usage: {
  analysis: {
    input_tokens: analysisInput,
    output_tokens: analysisOutput
  },
  reading: {
    input_tokens: readingInput,
    output_tokens: readingOutput
  },
  total_input_tokens: totalInput,
  total_output_tokens: totalOutput,
  total_tokens: totalInput + totalOutput,
  analysis_input_tokens: analysisInput,
  analysis_output_tokens: analysisOutput,
  reading_input_tokens: readingInput,
  reading_output_tokens: readingOutput,
  estimated_usd: Number(estimatedCost.toFixed(6))
},

estimated_cost_usd: Number(
  estimatedCost.toFixed(6)
)
  
  });
  
  } catch (error) {
  console.error("Stillwater AI error:", error);
  
  return res.status(500).json({
  error:
  error?.message ||
  "เกิดข้อผิดพลาดในการอ่านไพ่"
  });
  }
  }

module.exports = main;
