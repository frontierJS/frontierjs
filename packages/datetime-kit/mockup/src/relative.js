// import ms from 'ms'
import { formatMap } from './core.js'

function relative (val, format = '', options = {style:"short", precision: 2}) {
  const isFutureTime = val > 0

  if (typeof format === "object") {
    options = format
    format = null
  }
  options.keys = []

  // Defaults to date-fns type format

  // Step 1:
  // Replace tokens with date/time unit and
  // set styles by unit on options for formatting
  if (format) {
    const regex = Object.keys(formatMap)
      .map((key, i) => (i ? '|' + key : key))
      .join('')

    format = format.replace(new RegExp(regex, 'g'), (token) => {
      const { unit, style } = formatMap[token]
      // Convert 2-digit to long for relativeTimeFormat
      options[unit] = style === 'numeric' ? 'narrow' : style === '2-digit' ? 'short' : style
      return '${' + unit + '}'
    })

    format = isFutureTime ? 'in about ' + format : 'about ' + format + ' ago'
  }

  // Step 2:
  // Loop over each unit of time (years down to seconds)
  // Calculate the amount for each unit defined in the format (and included as a options[key])
  // Set the text value based on the defined formatting options
  const msPerUnitOfTime = Object.entries(formatMap).flatMap(([tokenKey, { ms, unit }]) => ms ? [{ unit, ms }] : []) // [{unit: 'hour', ms: 3600 * 1000}]
  const values = msPerUnitOfTime.reduce((acc, timeObj) => {
    if (format) {
      if (!Object.keys(options).includes(timeObj.unit)) return acc
    }

    const relativeMs = options.keys.reduce((newVal, { ms }) => newVal % ms, val)
    options.keys.push(timeObj)

    const relativeTime = new Intl.RelativeTimeFormat('en', { style: options[timeObj.unit] || options.style || 'short' })
      .format(Math.floor(Math.abs(relativeMs) / timeObj.ms), timeObj.unit)

    const hasNarrowStyling = options[timeObj.unit] ? options[timeObj.unit] === 'narrow' : options.style === 'narrow'
    let [_, value, timeUnitText] = relativeTime.split(' ')
    if (timeUnitText) {
      timeUnitText = hasNarrowStyling ? timeUnitText[0] : ' ' + timeUnitText
    }
    acc[timeObj.unit] = value + (timeUnitText|| '')

    return acc
  }, {})

  // console.debug(values)

  // Step 3: Replace time unit values in respective spots in format string
  if (format) {
    // console.debug(format)
    return format.replace(/\${\s*(\w+?)\s*}/g, (_, segment) => values[segment])
  } else {
    let count = options.precision || 2
    const res = Object.values(values).reduce((acc, unit) => {
      if (count && unit[0] !== "0") {
        acc += unit + ' '
        count--
      }

      return acc
    }
    , '').trim()

    // console.debug(res)
    return res
  }
}

function relativeTo (date, dateTo, format, options) {
  return relative(date - dateTo, format, options)
}

function relativeToNow (date, format, options) {
  return relative(date - new Date(), format, options)
}

export {relative, relativeTo, relativeToNow }
