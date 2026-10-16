/** Parse the form's explicit day/month/year order as an ISO calendar date. */
export function birthdateToIso(value: string): string | null {
  const match = /^(\d{2})\s*\/\s*(\d{2})\s*\/\s*(\d{4})$/.exec(value.trim())
  if (!match) return null
  const day = Number(match[1])
  const month = Number(match[2])
  const year = Number(match[3])
  const check = new Date(Date.UTC(year, month - 1, day))
  if (check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) return null
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** Add clear DD / MM / YYYY separators while keeping partial input editable. */
export function formatBirthdateInput(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 8)
  if (digits.length <= 2) return digits
  if (digits.length <= 4) return `${digits.slice(0, 2)} / ${digits.slice(2)}`
  return `${digits.slice(0, 2)} / ${digits.slice(2, 4)} / ${digits.slice(4)}`
}

/** Convert the date picker's ISO value without passing through local Date math. */
export function isoToBirthdateInput(value: string): string {
  const [year, month, day] = value.split('-')
  return `${day} / ${month} / ${year}`
}
