export type TarotLanguage = 'th' | 'en'

export type TarotCard = {
  id: number
  name: string
  image: string
  meaning: {
    th: string
    en?: string
  }
}

export type TarotDeck = {
  id: string
  name: string
  version: number
  provenance: {
    repository: string
    ref: string
    file: string
    blob: string
    meaningsField: string
  }
  cards: TarotCard[]
}
