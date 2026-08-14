// Format styles could include
// numeric, 2-digit, narrow, short, long

export const formatMap = {
  YYYY: {
    unit: 'year',
    style: 'numeric',
    ms: 31557600000
  },
  YY: {
    unit: 'year',
    style: '2-digit'
  },
  QQQQ: {
    unit: 'quarter',
    style: 'long'
  },
  QQQ: {
    unit: 'quarter',
    style: 'short'
  },
  QQ: {
    unit: 'quarter',
    style: '2-digit'
  },
  Q: {
    unit: 'quarter',
    style: 'numeric'
  },
  MMMM: {
    unit: 'month',
    style: 'long'
  },
  MMM: {
    unit: 'month',
    style: 'short'
  },
  MM: {
    unit: 'month',
    style: '2-digit'
  },
  M: {
    unit: 'month',
    style: 'numeric',
    ms: 31557600000 / 12
  },
  WWWW: {
    unit: 'week',
    style: 'month-long'
  },
  WWW: {
    unit: 'week',
    style: 'month-short'
  },
  WW: {
    unit: 'week',
    style: '2-digit'
  },
  W: {
    unit: 'week',
    style: 'numeric',
    ms: 7 * 24 * 3600 * 1000
  },
  DDDD: {
    unit: 'weekday',
    style: 'long'
  },
  DDD: {
    unit: 'weekday',
    style: 'short'
  },
  DD: {
    unit: 'day',
    style: '2-digit'
  },
  D: {
    unit: 'day',
    style: 'numeric',
    ms: 24 * 3600 * 1000
  },
  // Could become ordinal like `3rd hour`
  // hhh: {
  //   unit: 'hour',
  //   style: 'long'
  // },
  hh: {
    unit: 'hour',
    style: '2-digit'
  },
  h: {
    unit: 'hour',
    style: 'numeric',
    ms: 3600 * 1000
  },
  // Could become ordinal like `3rd minute`
  // mmm: {
  //   unit: 'minute',
  //   style: 'long'
  // },
  mm: {
    unit: 'minute',
    style: '2-digit'
  },
  m: {
    unit: 'minute',
    style: 'numeric',
    ms: 60 * 1000
  },
  ss: {
    unit: 'second',
    style: '2-digit'
  },
  s: {
    unit: 'second',
    style: 'numeric',
    ms: 1000
  },
  aaa: {
    unit: 'dayPeriod',
    style: 'long' // in the morning, in the evening
  },
  aa: {
    unit: 'dayPeriod',
    style: 'short' // AM/PM
  },
  a: {
    unit: 'dayPeriod',
    style: 'narrow' //a/p
  },
  ttt: {
    unit: 'timeZoneName',
    style: 'long'
  },
  tt: {
    unit: 'timeZoneName',
    style: 'short'
  },
  t: {
    unit: 'timeZoneName',
    style: 'short'
  }
}

// Could implement this
// 00:00	night1	night
// 06:00	morning1	morning
// 12:00	afternoon1	afternoon
// 18:00	evening1	evening
// 21:00	night1	night

export const dayPeriodMap = {
  shortAM: 'AM',
  shortPM: 'PM',
  narrowAM: 'A',
  narrowPM: 'P'
}

export function getFormatMapKeys() {
  return Object.keys(formatMap)
    .map((key, i) => (i ? '|' + key : key))
    .join('')
}

export function isValidDate(date) {
  return date && Object.prototype.toString.call(date) === '[object Date]' && !isNaN(date)
}

// https://weeknumber.com/how-to/javascript
function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}

function pad(n) {
  return n < 10 ? '0' + n : String(n)
}

export function getWeekNumber(date) {
  const timeDifference = date - new Date('2023-01-01')
  // Calculate the number of weeks elapsed
  const weeksElapsed = Math.floor(timeDifference / (7 * 24 * 60 * 60 * 1000))
  // Calculate the current week number, repeating every 4 weeks
  return (weeksElapsed % 4) + 1
}

function getWeekOfMonth(date) {
  const d = new Date(date)
  const day = d.getDate()
  const startOfMonth = new Date(d.getFullYear(), d.getMonth(), 1)
  const startDay = startOfMonth.getDay() || 7 // Shift Sunday to 7
  return Math.ceil((day + startDay - 1) / 7)
}

// For ISO week number (week of year)
export const getISOWeek = (date) => {
  const temp = new Date(date.getTime())
  temp.setHours(0, 0, 0, 0)
  temp.setDate(temp.getDate() + 3 - ((temp.getDay() + 6) % 7)) // Thursday of current week
  const week1 = new Date(temp.getFullYear(), 0, 4)
  return 1 + Math.round(((temp - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7)
}

export function getWeek(date, style = 'narrow') {
  switch (style) {
    case 'numeric':
      return String(getISOWeek(date))
    case '2-digit':
      return pad(getISOWeek(date))
    case 'month-short':
      return `W${getWeekOfMonth(date)}`
    case 'month-long':
      return `${ordinal(getWeekOfMonth(date))} week`
    default:
      return String(getISOWeek(date))
  }
}

export function getQuarter(date, style = 'numeric') {
  const q = Math.floor(date.getMonth() / 3) + 1
  switch (style) {
    case 'long':
      return `${ordinal(q)} quarter`
    case 'short':
      return `Q${q}`
    case '2-digit':
      return pad(q)
    case 'numeric':
    default:
      return String(q)
  }
}