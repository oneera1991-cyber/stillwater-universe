/*
STILLWATER — QUESTION TOPIC (log-only; never shown, never sent to the reader)
Cheap keyword rules (TH + EN) → one topic per free question, for the owner's
"what do people ask about" tally. Runs in microseconds; no AI call.

Topics (first match in PRIORITY order wins; a question can mention several):
  ex        ex / reconciliation / getting back together
  love      love, crush, partner, marriage, soulmate
  health    illness, body, mental wellbeing (refused questions are still counted)
  study     study, exams, school, university, scholarship
  work      job, career, boss, interview, business
  money     money, debt, income, lottery, investing
  family    parents, children, siblings, home
  friends   friends, colleagues (non-romantic), social
  decision  should I / A or B / choose
  self      self, life direction, purpose, future in general
  other     nothing matched
Safety-case (self-harm / crisis) rows use topic "safety_case" (set by the caller).
*/

const RULES = [
  ["ex", [/แฟนเก่า|คนเก่า|เอ็กซ์|กลับมาคืนดี|คืนดี|กลับมาคบ|กลับมาหา|รีเทิร์น|เลิกกัน|เลิกรา|อดีตคนรัก|หย่า/,
          /\bex\b|\bex-|my ex|get(?:ting)? back together|reconcil|come back to me|break ?up|broke up|divorc/i]],
  ["love", [/ความรัก|แฟน|คนรัก|คนคุย|คุยกัน|แอบชอบ|ชอบเขา|ชอบเค้า|ปิ๊ง|เนื้อคู่|คู่ครอง|คู่แท้|แต่งงาน|สามี|ภรรยา|เมีย|ผัว|จีบ|โสด|มือที่สาม|นอกใจ|เขาคิดยังไง|เค้าคิดยังไง|เขารู้สึก|เค้ารู้สึก|หัวใจ|คนที่ชอบ|ความสัมพันธ์/,
            /\blove|crush|boyfriend|girlfriend|partner|relationship|soul ?mate|marri|husband|wife|dating|\bdate\b|single|cheat|affair|feel(?:s)? about me|think(?:s)? of me|romanc/i]],
  ["health", [/สุขภาพ|ป่วย|โรค|หาหมอ|ผ่าตัด|รักษา|อาการ|มะเร็ง|ตั้งครรภ์|ท้อง(?!แท้)|มีลูกยาก|นอนไม่หลับ|ซึมเศร้า|เครียดมาก|วิตกกังวล|น้ำหนัก|ลดน้ำหนัก|จิตใจ|สภาพจิต/,
              /health|\bill(?:ness)?\b|sick|disease|surgery|doctor|hospital|cancer|pregnan|fertility|insomnia|depress|anxiety|weight|mental|recover/i]],
  ["study", [/เรียน|สอบ(?!ถาม)|มหาลัย|มหาวิทยาลัย|ปริญญา|ทุนการศึกษา|ทุนเรียน|ติดคณะ|เกรด|วิทยานิพนธ์|ธีสิส|โรงเรียน|แอดมิชชั่น|tcas/i,
             /stud(?:y|ies|ying)|exam|test score|school|universit|college|degree|scholarship|thesis|grade|admission|course/i]],
  ["work", [/งาน|อาชีพ|เจ้านาย|หัวหน้า|สัมภาษณ์|ลาออก|เลื่อนตำแหน่ง|ตำแหน่ง|ออฟฟิศ|บริษัท|ธุรกิจ|ร้าน|ลูกค้า|กิจการ|ย้ายงาน|หางาน|สมัครงาน|ฟรีแลนซ์|โปรเจกต์|โปรเจค/,
            /\bjob|work|career|boss|manager|interview|resign|quit|promot|office|company|business|client|customer|freelanc|project|hired|employ/i]],
  ["money", [/เงิน|หนี้|รายได้|รายจ่าย|ลงทุน|หุ้น|คริปโต|หวย|ลอตเตอรี่|โชคลาภ|ร่ำรวย|รวย|การเงิน|ผ่อน|กู้|ขายของ|ขายดี|มรดก|ค่าใช้จ่าย/,
             /money|debt|income|salary|invest|stock|crypto|lottery|lucky|\brich\b|wealth|financ|loan|mortgage|sales|inherit|afford/i]],
  ["family", [/ครอบครัว|พ่อ(?!ค้า)|แม่(?!น)|ลูก(?!ค้า)|พี่น้อง|พี่ชาย|พี่สาว|น้องชาย|น้องสาว|คุณตา|คุณยาย|ปู่|ญาติ|ที่บ้าน|ทางบ้าน|สะใภ้|ลูกเขย/,
              /family|father|mother|\bdad|\bmom|\bmum|parent|\bsons?\b|daughter|child|kids?\b|brother|sister|sibling|grand|relative|in-law|home/i]],
  ["friends", [/เพื่อน|เพื่อนร่วมงาน|สังคม|กลุ่มเพื่อน|ทะเลาะกับเพื่อน/,
               /friend|colleague|coworker|co-worker|social|people around me/i]],
  ["decision", [/ควรจะ|ควรไหม|ควรมั้ย|ดีไหม|ดีมั้ย|ดีหรือไม่|หรือว่า|หรือไม่|เลือก|ตัดสินใจ|ทางไหน|อันไหน|ไปหรือ|ย้ายไป|ตกลงไหม|ตกลงดี/,
                /should i|which (?:one|way|option)|\bor\b.*\?|choose|choice|decid|decision|go for it|worth it/i]],
  ["self", [/ตัวเอง|ชีวิต|อนาคต|เป้าหมาย|ความฝัน|ทิศทาง|ตัวตน|ความสุข|เส้นทาง|จะเป็นยังไง|ปีนี้|ปีหน้า|ดวง|ช่วงนี้|เดือนนี้|เปลี่ยนแปลง/,
            /myself|my life|life|future|purpose|direction|dream|goal|who am i|happiness|path|this year|next year|fortune|change/i]]
];

export const TOPICS = [...RULES.map(([k]) => k), "other", "safety_case"];

/** Topic for one question (+ optional context). Pure, never throws. */
export function classifyTopic(question, context = "") {
  try {
    const q = String(question || "");
    if (!q.trim()) return "other";
    for (const [topic, res] of RULES) if (res.some((re) => re.test(q))) return topic;
    const c = String(context || "");
    if (c.trim()) for (const [topic, res] of RULES) if (res.some((re) => re.test(c))) return topic;
    return "other";
  } catch { return "other"; }
}
