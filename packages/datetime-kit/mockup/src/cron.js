// Part 1
// Create a cron config
const parseMap = {
    '/': 'every',
    '-': 'between',
    ',': 'in',
    days: ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'],
    // cron: ['Minutes', 'Hours', 'Date', 'Month', 'Day'],
    cron: [
      {key: 'minutes', max: 60},
      {key: 'hours', max: 24},
      {key: 'date', max: 24},
      {key: 'month', max: 31},
      {key: 'day', max: 6},
  ],
}

function parseCron (line) {
  const {cron, days, ...map} = parseMap
  // Sanitize input
  const items = line.toLowerCase().replace(/[a-z]+/g, (text) => days.indexOf(text.substring(0, 2))).split(/\s|\t/)

  const config = items.reduce((acc, item, index) => {
    const defaults = cron[index]
    const obj = acc[defaults.key] = item === '*' ? { ...defaults, type: '*', values: [] } : { ...defaults, type: 'equal', values: [+item] }

    item.replace(/\/|,|-/, (match) => {
      obj.type = map[match]
      obj.values = item.split(match).flatMap((i) => i !== '*' ? +i : [/* empty */])
    })

    return acc
  }, {})

  return config
}



// Part 2
// Validate a date with cron config
const validateCronMap = {
  equal: ([value], current) => value === current,
  every: ([value], current) => current % value === 0,
  in: (values, current) => values.includes(current),
  between: ([begin, end], current) => current >= begin && current <= end,
  '*': (values, current) => true,
  // getNext: (cfg, prev) => {
  //   let next = cfg.current + 1
  //   while (true) {
  //     const res = validateCronMap[cfg.type](cfg.values, next)
  //     // console.log(res)
  //     if (res) return next

  //     if (next === cfg.max) {
  //       cfg.maxReached = true
  //       next = 0
  //     } else {
  //       next++
  //     }
  //   }
  // }
}

function getDateMap(datetime, options) {
  const local = datetime.toLocaleString('en', options)
  const [dateString, timeString] = local.split(', ')

  const [month, date, year] = dateString.split('/').map(Number)
  const [hours, minutes] = timeString.split(':').map(Number)

  const dayOfWeek = datetime.toLocaleString('en', {...options, weekday: 'short'}).toLowerCase()
  const day = parseMap.days.indexOf(dayOfWeek.substring(0, 2))

  return {
    minutes,
    hours,
    date,
    month,
    year,
    day
  }
}

function validate (cronSettings, date, options = {}) {
  const {findNext, timeZone} = options
  date.setSeconds(0, 0)
  const map = validateCronMap
  const dateMap = getDateMap(date, {timeZone, hour12: false})

  const isValid = Object.values(cronSettings).map((cfg) => {
    cfg.current = dateMap[cfg.key]
    cfg.valid = map[cfg.type](cfg.values, cfg.current)
    // cfg.next = cfg.valid ? cfg.current : map.getNext(cfg)
    return cfg.valid
  }).every(Boolean)


  // Finds next valid date
  if (findNext) {
    const nextDate = new Date(date)
    let count = findNext === true ? 60 * 24 : findNext

    while (count) {
      //NOTE: [improvement] can we make this smarter?
      nextDate.setMinutes(nextDate.getMinutes() + 1)

      const result = validate(cronSettings, nextDate, {timeZone})

      if (result.isValid) {
        return {isValid: false, date: result.date, count}
      }

      count--

      if (!count) {
        return {isValid: false, date: undefined}
      }
    }
  }

  return {isValid, date}
}

function parse(line, date, options = {}) {
  const config = parseCron(line)
  if (date instanceof Date && isNaN(date.getTime())) {
    return {error: 'Invalid Date', date}
  }
  return validate(config, date, options)
}

const Cron = {
  parse
}

export default Cron