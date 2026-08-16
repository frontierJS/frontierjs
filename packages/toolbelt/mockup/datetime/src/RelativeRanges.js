export function getTimeZoneOffset(timeZone) {
  const locale = new Date().toLocaleDateString('en-us', {
    timeZoneName: 'longOffset',
    timeZone
  })
  const offset = locale.split(' ').pop()
  // returns GMT-0X:00
  // example from string:
  // new Date("2024-01-01" + " 00:00" + " GMT-06:00");
  // new Date(`${date} ${time} ${offset}`);
  return offset
}

function getParts(timeZone, locale = 'en-US') {
  const now = new Date()

  const dateParts = new Intl.DateTimeFormat(locale, {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now)

  const timeParts = new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(now)

  console.log('parts:', dateParts, timeParts)
  const parts = [...dateParts, ...timeParts].reduce((acc, { type, value }) => {
    if (type !== 'literal') acc[type] = value
    return acc
  }, {})

  return {
    year: Number(parts.year),
    month: Number(parts.month) - 1,
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  }
}

function parseTimeString(time = '00:00') {
  const [hour, minute, second] = time.split(':').map(Number)
  return {
    hour: hour ?? 0,
    minute: minute ?? 0,
    second: second ?? 0
  }
}

const Core = {
  _config: {
    timeZone: 'Etc/UTC'
  },

  setTimeZone(timeZone) {
    this._config.timeZone = timeZone
  },

  get timeZone() {
    return this._config.timeZone
  },

  // NOTE: This can't work this way
  // withTimeZone(timeZone) {
  //   const clone = {
  //     ...this,
  //     _config: { ...this._config, timeZone }
  //   }
  //   return clone
  // },

  time: {
    day: 86400000
  },

  relations: ['prev', 'curr', 'next'],

  cal: { Day: ['Date', 7], Month: ['Month', 12], Year: ['FullYear'] },

  refs: {
    Day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    Month: [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec'
    ]
  },
  date: (opts = {}) => {
    const tz = Core._config.timeZone
    // console.log({ tz })
    const { date, time = '00:00', timeZone = tz, year, month, day } = opts

    // NOTE: Get a now to work with BASED on browser timeZone
    const now = new Date()

    // NOTE: Get now's date for specific timeZone
    const _date =
      date || new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone }).format(now)

    // NOTE: Get now's time for specific timeZone
    const _time =
      time || new Intl.DateTimeFormat('en-US', { timeStyle: 'long', timeZone }).format(now)

    // NOTE: Create a fresh datetime based on date, time, and timeZone
    const datetime = new Date([_date, _time, getTimeZoneOffset(timeZone)].join(' '))

    // console.log({
    //   now,
    //   key: opts.key,
    //   date,
    //   _date,
    //   time,
    //   _time,
    //   timeZone,
    //   month,
    //   day,
    //   datetime
    // })

    if (year !== undefined) {
      datetime.setUTCFullYear(
        typeof year === 'function' ? year(datetime.getUTCFullYear()) : year
      )
    }
    if (month !== undefined) {
      datetime.setUTCMonth(
        typeof month === 'function' ? month(datetime.getUTCMonth()) : month
      )
    }
    if (opts.key !== 'Day' && day !== undefined) {
      datetime.setUTCDate(typeof day === 'function' ? day(datetime.getUTCDate()) : day)
    }

    return datetime
  },
  getDelta(opts, { rel, key, ref, d }) {
    // console.log('-------:DELTA:-----')
    // console.log({ opts }, { rel, key, ref, d })
    const datetime = opts.datetime ?? this.date(opts)
    const current = datetime['getUTC' + key]()
    // console.log('getUTC[ref]', { current })
    // console.log('currentDay', datetime['getUTC' + key]())

    let target = opts[key]
    // console.log({ target })
    if (typeof target === 'function') target = target(current)
    if (target === undefined) {
      if (rel === 'prev') target = current - 1
      else if (rel === 'next') target = current + 1
      else target = current
    }

    const normalize = (n) => ((n % d) + d) % d

    // console.log({ rel, target, current })

    if (rel === 'prev') {
      const diff = normalize(current - target)
      return diff === 0 ? -d : -diff
    }
    if (rel === 'next') {
      const diff = normalize(target - current)
      return diff === 0 ? d : diff
    }
    if (rel === 'curr') {
      // NOTE: may need to be adjust based on connect
      return target - current
    }

    // console.log('-------:DELTA:-----')
    return 0
  },
  shift(opts) {
    const date = new Date(opts.datetime)
    // console.log('shift this date:', date)
    const fnName = opts.ref === 'Day' ? 'Date' : opts.ref
    date['setUTC' + fnName](date['getUTC' + fnName]() + opts.delta)
    return date
  }
}

Core.process = function ({ rel, key, ref, d }) {
  return function (opts = {}) {
    opts.datetime ??= Core.date(opts)
    const delta = Core.getDelta(opts, { rel, key, ref, d })
    // console.log({ delta, ref, rel })
    return delta ? Core.shift({ ...opts, delta, ref }) : opts.datetime
  }
}

Core.relations.forEach((rel) => {
  // NOTE: d is the index of the cal.type
  Object.entries(Core.cal).forEach(([key, [ref, d]]) => {
    Core[rel + key] = Core.process({ rel, key, ref, d })
  })

  Object.entries(Core.refs).forEach(([key, list]) => {
    list.forEach((label, index) => {
      Core[rel + label] = (opts) => Core[rel + key]({ ...opts, [key]: index, key })
    })
  })
})

export const Relative = Core

export const Range = {
  day: {
    rolling() {
      const today = Core.date()
      const hours24 = new Date(+today - Core.time.day)
      return [hours24, today]
    },
    current() {
      const today = Core.currDay()
      const tomorrow = Core.nextDay()

      return [today, tomorrow]
    },
    last() {
      const today = Core.currDay()
      const yesterday = Core.prevDay()
      return [yesterday, today]
    }
  },
  week: {
    rolling() {
      const today = Core.date()
      const days7 = new Date(+today - Core.time.day * 7)
      return [days7, today]
    },
    current() {
      const monday = Core.currMon()
      const tomorrow = Core.nextDay()
      return [monday, tomorrow]
    },
    last() {
      const monday = Core.currMon()
      const lastMonday = new Date(+monday - Core.time.day * 7)
      return [lastMonday, monday]
    }
  },
  month: {
    rolling() {
      const today = Core.date()
      const days30 = new Date(+today - Core.time.day * 30)
      return [days30, today]
    },
    current() {
      const start = Core.currMonth({ day: 1 })
      const now = Core.date()
      return [start, now]
    },
    last() {
      return [Core.prevMonth({ day: 1 }), Core.currMonth({ day: 1 })]
    }
  },
  year: {
    rolling() {
      const today = Core.date()
      const days365 = new Date(+today - Core.time.day * 365)
      return [days365, today]
    },
    current() {
      const start = Core.currYear({ month: 0, day: 1 })
      const now = Core.date()
      return [start, now]
    },
    last() {
      return [Core.prevYear({ month: 0, day: 1 }), Core.currYear({ month: 0, day: 0 })]
    }
  }
}
