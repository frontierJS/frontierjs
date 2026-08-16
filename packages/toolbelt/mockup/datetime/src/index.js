import { formatMap, getWeek } from './core.js'
import { relative, relativeTo, relativeToNow  } from './relative.js'
import { format } from './format.js'
import { add } from './add.js'
import { extend } from './extend.js'
import { getDateAndTime } from './getDateAndTime.js'
// SetTimezone?
// ms Library?

export {
  relative,
  relativeTo,
  relativeToNow,
  format,
  add,
  extend,
  getDateAndTime,
  formatMap,
  getWeek
}
/** Date Basics:
  const d = new Date();

  // Standard
  console.log('ISOString', d.toISOString())
  console.log('JSON', d.toJSON())
  console.log('UTCString', d.toUTCString())

  //
  console.log('String', d.toString())
  console.log('DateString', d.toDateString())
  console.log('TimeString', d.toTimeString())

  //
  console.log('LocaleString', d.toLocaleString())
  console.log('LocaleDateString', d.toLocaleDateString())
  console.log('LocalTimeString', d.toLocaleTimeString())
*/

/**
 *  Date.prototype.format = function (format, options) {
 *    return format(this, format, options)
 * }
 *
 *  Date.prototype.relativeTo = function (dateTo, format) {
 *    return relative(this, dateTo, format)
 * }
 *
 *  Date.prototype.relativeToNow = function (format) {
 *    return relative(this, format)
 * }
 */