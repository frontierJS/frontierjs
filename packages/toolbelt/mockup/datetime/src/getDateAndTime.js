function getDateAndTime(datetime, {utc = false, seconds = false} = {}) {
  if (utc) {
    const [datetimestring, msZ] = datetime.toJSON().split('.')
    const [date, time] =  datetimestring.split('T')
    return {date, time: seconds ? time : time.substring(0,5)}
  }

  const time = datetime.toLocaleTimeString('en', {hourCycle: 'h23'})
  return {
    date: datetime.toLocaleDateString('en-GB').split('/').reverse().join('-'),
    time: seconds ? time : time.substring(0,5)
  }
}

export {getDateAndTime}