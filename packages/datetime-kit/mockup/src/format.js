import { isValidDate, formatMap, dayPeriodMap, getWeek, getQuarter } from './core.js'

function format(date, format, options = { hour12: true }) {
  date = typeof date === 'string' ? new Date(date) : date
  if (!isValidDate(date)) {
    throw new Error('::: Received date value does not make a valid date.')
  }

  if (typeof format === 'object') {
    options = format
    format = null
  }
  // Allow for a default timeZone stored on the date
  options.timeZone ||= date.timeZone

  // If no format string is provided, fallback to Intl formatting
  if (!format && options) {
    return new Intl.DateTimeFormat('en', options).format(date)
  }

  // === STEP 0: Handle literal text inside square brackets ===
  const literals = []
  const LITERAL_PREFIX = '__LIT__'

  const formatWithPlaceholders = format.replace(/\[([^\]]+)\]/g, (_, literal) => {
    const placeholder = `${LITERAL_PREFIX}${literals.length}__`
    literals.push(literal)
    return placeholder
  })

  // === STEP 1: Replace formatting tokens with placeholders ===
  const regex = Object.keys(formatMap).join('|')
  let tokenizedFormat = formatWithPlaceholders.replace(new RegExp(regex, 'g'), (key) => {
    const { unit, style } = formatMap[key]
    options[unit] = style
    return `\${${unit}}`
  })

  // === STEP 2: Get Intl parts ===
  const values = new Intl.DateTimeFormat('en', options)
    .formatToParts(date)
    .reduce((acc, { type, value }) => {
      acc[type] = value
      return acc
    }, {})

  // === STEP 2.5: Add dayPeriod manually (AM/PM workaround) ===
  if (options.dayPeriod && options.dayPeriod !== 'long' && values.hour) {
    const tzHour = _getHourInZone(date, options.timeZone)
    const style = options.dayPeriod + (tzHour >= 12 ? 'PM' : 'AM')
    values.dayPeriod = dayPeriodMap[style]
  }

  // === STEP 2.9: Add week/quarter values manually ===
  values.week = getWeek(date, options.week)
  values.quarter = getQuarter(date, options.quarter)

  // === STEP 3: Replace placeholders with actual values ===
  let result = tokenizedFormat.replace(/\${\s*(\w+?)\s*}/g, (_, segment) => {
    return values[segment] || ''
  })

  // === STEP 4: Restore literal text ===
  literals.forEach((text, index) => {
    result = result.replace(`${LITERAL_PREFIX}${index}__`, text)
  })

  return result
}

function _getHourInZone(date, timeZone) {
  return Number(
    new Intl.DateTimeFormat('en', { hour: '2-digit', hour12: false, timeZone })
      .formatToParts(date)
      .find((p) => p.type === 'hour')?.value
  )
}

export { format }
