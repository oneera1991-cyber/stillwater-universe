export type StillwaterCard = {
  id: string
  name: string
  nameTh: string
  symbol: string
  essence: string
  essenceTh: string
  light: string
  shadow: string
}

export const CARDS: StillwaterCard[] = [
  {
    id: 'still-water',
    name: 'Still Water',
    nameTh: 'น้ำนิ่ง',
    symbol: '🌊',
    essence: 'The quiet depth beneath the surface',
    essenceTh: 'ความลึกที่เงียบงันใต้พื้นผิว',
    light: 'clarity, reflection, hidden strength',
    shadow: 'stagnation, avoidance, suppressed feeling',
  },
  {
    id: 'ember',
    name: 'The Ember',
    nameTh: 'ประกายไฟ',
    symbol: '🕯️',
    essence: 'A flame that refuses to be extinguished',
    essenceTh: 'เปลวไฟที่ปฏิเสธการดับสูญ',
    light: 'resilience, passion, slow transformation',
    shadow: 'burnout, stubbornness, destructive desire',
  },
  {
    id: 'the-door',
    name: 'The Door',
    nameTh: 'ประตู',
    symbol: '🚪',
    essence: 'A threshold between what was and what can be',
    essenceTh: 'ธรณีประตูระหว่างสิ่งที่ผ่านมาและสิ่งที่อาจเป็น',
    light: 'transition, opportunity, courage to cross',
    shadow: 'hesitation, fear of change, closed possibility',
  },
  {
    id: 'the-thread',
    name: 'The Thread',
    nameTh: 'สายใย',
    symbol: '🧵',
    essence: 'Invisible connections that hold your world together',
    essenceTh: 'สายสัมพันธ์มองไม่เห็นที่ยึดโลกของคุณไว้',
    light: 'bond, continuity, unseen support',
    shadow: 'entanglement, dependency, threads that bind too tight',
  },
  {
    id: 'night-bloom',
    name: 'Night Bloom',
    nameTh: 'ดอกไม้กลางคืน',
    symbol: '🌙',
    essence: 'Beauty that only unfolds in darkness',
    essenceTh: 'ความงามที่เบ่งบานในความมืด',
    light: 'quiet flourishing, intuition, patience',
    shadow: 'hiding from the world, fear of being seen',
  },
  {
    id: 'the-weight',
    name: 'The Weight',
    nameTh: 'ภาระ',
    symbol: '⚖️',
    essence: 'What you carry, and what carries you',
    essenceTh: 'สิ่งที่คุณแบกรับ และสิ่งที่แบกรับคุณ',
    light: 'responsibility, gravity, earned strength',
    shadow: 'burden, guilt, carrying what is not yours',
  },
  {
    id: 'the-map',
    name: 'The Map',
    nameTh: 'แผนที่',
    symbol: '🗺️',
    essence: 'You are not lost — you are between knowings',
    essenceTh: 'คุณไม่ได้หลงทาง — คุณอยู่ระหว่างการรู้จัก',
    light: 'direction, self-knowledge, finding your way',
    shadow: 'overthinking the route instead of walking it',
  },
  {
    id: 'the-mirror',
    name: 'The Mirror',
    nameTh: 'กระจก',
    symbol: '🪞',
    essence: 'What you see in others lives inside you too',
    essenceTh: 'สิ่งที่คุณเห็นในผู้อื่น ก็อาศัยอยู่ในตัวคุณด้วย',
    light: 'self-awareness, honesty, reflection',
    shadow: 'self-deception, projection, distorted self-image',
  },
  {
    id: 'root',
    name: 'The Root',
    nameTh: 'รากเหง้า',
    symbol: '🌿',
    essence: 'Ground yourself before you grow',
    essenceTh: 'หยั่งรากก่อนที่จะเติบโต',
    light: 'stability, ancestry, deep belonging',
    shadow: 'being stuck, fear of outgrowing your roots',
  },
  {
    id: 'the-crossing',
    name: 'The Crossing',
    nameTh: 'ทางแยก',
    symbol: '✦',
    essence: 'Two roads are one invitation',
    essenceTh: 'สองทางคือคำเชิญเดียวกัน',
    light: 'choice, agency, trust in your own judgment',
    shadow: 'indecision, paralysis, outsourcing your truth',
  },
  {
    id: 'the-fog',
    name: 'The Fog',
    nameTh: 'หมอก',
    symbol: '☁️',
    essence: 'Uncertainty is not the enemy — it is the medium',
    essenceTh: 'ความไม่แน่ใจไม่ใช่ศัตรู — แต่คือตัวกลาง',
    light: 'mystery, openness, trusting the unseen',
    shadow: 'confusion, avoidance, refusing to move without clarity',
  },
  {
    id: 'the-gift',
    name: 'The Gift',
    nameTh: 'ของขวัญ',
    symbol: '🎁',
    essence: 'Something precious wrapped in difficulty',
    essenceTh: 'สิ่งล้ำค่าที่ห่อด้วยความยากลำบาก',
    light: 'unexpected blessing, gratitude, receiving',
    shadow: 'refusing gifts, strings attached, conditional love',
  },
]

export function drawCards(count: number): StillwaterCard[] {
  const shuffled = [...CARDS].sort(() => Math.random() - 0.5)
  return shuffled.slice(0, Math.min(count, CARDS.length))
}
