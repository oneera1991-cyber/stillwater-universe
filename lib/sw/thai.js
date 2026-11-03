/* Thai birth-day astrology: weekday (Thai day starts 06:00; Wednesday night = Wed 18:00–Thu 05:59), element, lucky/avoid colors.
   Colour table is the common Thai taksa set — TODO(Palm): review wording/colours. */
const DAYS = [
  { key: "sun", th: "วันอาทิตย์", element: "fire",  color: "แดง", lucky: ["เขียว", "ม่วง"], avoid: "ฟ้า" },
  { key: "mon", th: "วันจันทร์", element: "earth", color: "เหลือง", lucky: ["ขาว", "ส้ม"], avoid: "แดง" },
  { key: "tue", th: "วันอังคาร", element: "fire",  color: "ชมพู", lucky: ["ม่วง", "เทา"], avoid: "เหลือง" },
  { key: "wed", th: "วันพุธ (กลางวัน)", element: "water", color: "เขียว", lucky: ["ส้ม", "เหลือง"], avoid: "ชมพู" },
  { key: "thu", th: "วันพฤหัสบดี", element: "earth", color: "ส้ม", lucky: ["ฟ้า", "เขียว"], avoid: "ม่วง" },
  { key: "fri", th: "วันศุกร์", element: "water", color: "ฟ้า", lucky: ["ชมพู", "เหลือง"], avoid: "เทา" },
  { key: "sat", th: "วันเสาร์", element: "wind",  color: "ม่วง", lucky: ["ดำ", "ฟ้า"], avoid: "เขียว" }
];
const WED_NIGHT = { key: "wed_night", th: "วันพุธ (กลางคืน)", element: "wind", color: "เทา", lucky: ["ครีม", "ฟ้า"], avoid: "ส้ม" };
/** date "YYYY-MM-DD", time "HH:MM" local civil time at birth place; hasTime false → no day shift. */
export function thaiBirthDay(date, time = "12:00", hasTime = true) {
  const [y, m, d] = date.split("-").map(Number); const [hh] = time.split(":").map(Number);
  let wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (hasTime && hh < 6) wd = (wd + 6) % 7; // before sunrise → still the previous Thai day
  const wedNight = hasTime && ((wd === 3 && (hh >= 18 || hh < 6)));
  return { ...(wedNight ? WED_NIGHT : DAYS[wd]), weekday: wd, wedNight };
}
