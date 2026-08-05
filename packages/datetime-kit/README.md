# datetime-kit (currently in a differnt repo)

A lightweight JavaScript library that extends the native Date prototype with powerful formatting capabilities using modern Intl APIs.

## Installation

```bash
npm install @frontierjs/datetime-kit
```

## Usage

Simply import the library to extend the Date prototype with formatting capabilities:

```javascript
import { format } from '@frontierjs/datetime-kit';

const date = new Date();
console.log(format(date, 'MMMM DD, YYYY')); // "January 15, 2024"
console.log(format(date, 'hh:mm aa')); // "12:12 PM"
```

## Format Tokens

### Year

| Token  | Description           | Example |
| ------ | --------------------- | ------- |
| `YYYY` | Full year (4 digits)  | 2024    |
| `YY`   | Short year (2 digits) | 24      |

### Month

| Token  | Description                | Example |
| ------ | -------------------------- | ------- |
| `MMMM` | Full month name            | January |
| `MMM`  | Short month name           | Jan     |
| `MM`   | Month with leading zero    | 01      |
| `M`    | Month without leading zero | 1       |

### Week

| Token | Description | Example |
| ----- | ----------- | ------- |
| `WW`  | Week number | 03      |
| `W`   | Week number | 3       |

### Day

| Token  | Description              | Example |
| ------ | ------------------------ | ------- |
| `DDDD` | Full weekday name        | Monday  |
| `DDD`  | Short weekday name       | Mon     |
| `DD`   | Day with leading zero    | 01      |
| `D`    | Day without leading zero | 1       |

### Hour

| Token | Description               | Example |
| ----- | ------------------------- | ------- |
| `hh`  | Hour with leading zero    | 09      |
| `h`   | Hour without leading zero | 9       |

### Minute

| Token | Description                 | Example |
| ----- | --------------------------- | ------- |
| `mm`  | Minute with leading zero    | 05      |
| `m`   | Minute without leading zero | 5       |

### Second

| Token | Description                 | Example |
| ----- | --------------------------- | ------- |
| `ss`  | Second with leading zero    | 07      |
| `s`   | Second without leading zero | 7       |

### Day Period (AM/PM)

| Token | Description       | Example        |
| ----- | ----------------- | -------------- |
| `aaa` | Long day period   | in the morning |
| `aa`  | Short day period  | AM             |
| `a`   | Narrow day period | A              |

### Time Zone

| Token | Description         | Example               |
| ----- | ------------------- | --------------------- |
| `ttt` | Long timezone name  | Pacific Standard Time |
| `tt`  | Short timezone name | PST                   |
| `t`   | Short timezone name | PST                   |

## Examples

### Basic Usage

```javascript
import '@frontierjs/datetime-kit';

const now = new Date();

// Common formats
console.log(now.format('YYYY-MM-DD')); // "2026-01-15"
console.log(now.format('MM/DD/YYYY')); // "01/15/2026"
console.log(now.format('MMMM D, YYYY')); // "January 15, 2026"
```

### Time Formatting

```javascript
const date = new Date('2026-01-15 14:30:45');

console.log(date.format('h:mm aa')); // "2:30 PM"
console.log(date.format('hh:mm:ss')); // "14:30:45"
console.log(date.format('h:mm aaa')); // "2:30 in the afternoon"
```

### Advanced Formatting

```javascript
const date = new Date();

// Full date with weekday
console.log(date.format('DDDD, MMMM D, YYYY')); // "Monday, January 15, 2026"

// With timezone
console.log(date.format('MM/DD/YYYY h:mm aa ttt')); // "01/15/2026 2:30 PM Pacific Standard Time"

// Week information
console.log(date.format('WWW W of YYYY')); // "Week 3 of 2024"
```

### Custom Patterns

You can combine any tokens to create custom date formats:

```javascript
const date = new Date('2026-07-04 16:45:30');

console.log(date.format('DDD MMM D, YY')); // "Thu Jul 4, 26"
console.log(date.format('DDDD [the] D[th]')); // "Thursday the 4th" (escape literal text)
console.log(date.format('h:mm:ss aa on MMMM D')); // "4:45:30 PM on July 4"
```

### Internationalization

The formatting respects the user's locale for month names, weekday names, and other locale-specific formatting:

```javascript
// These will be formatted according to the user's browser locale
const date = new Date();
console.log(date.format('DDDD, MMMM D, YYYY')); 
// English: "Monday, January 15, 2026"
// Spanish: "lunes, enero 15, 2026" (if user's locale is Spanish)
```

## Utility Functions

### Week Numbers

Get ISO week numbers:

```javascript
import { getWeek } from '@frontierjs/datetime-kit';

const date = new Date('2026-01-15');
console.log(getWeek(date)); // 3 (ISO week number)
```

### Date Validation

Validate if a value is a valid date:

```javascript
import { isValidDate } from '@frontierjs/datetime-kit';

console.log(isValidDate(new Date())); // true
console.log(isValidDate('invalid')); // false
console.log(isValidDate(new Date('invalid'))); // false
```

## Browser Support

This library uses the modern `Intl` API which is supported in:
- Chrome 24+
- Firefox 29+
- Safari 10+
- Edge 12+
- Node.js 8+

## Features

- **Lightweight**: Minimal footprint using native browser APIs
- **Modern**: Built on top of the Intl.DateTimeFormat API
- **Flexible**: Support for custom format patterns
- **Localized**: Respects user's locale settings
- **Type Safe**: Written with TypeScript support in mind

## License

MIT License - see LICENSE file for details.

## Date Basics:

```js
const d = new Date();

// Standard
console.log('ISOString', d.toISOString())
[ 'ISOString', '2025-09-23T14:25:40.774Z' ]
console.log('JSON', d.toJSON())
[ 'JSON', '2025-09-23T14:25:40.774Z' ]

console.log('UTCString', d.toUTCString())
[ 'UTCString', 'Tue, 23 Sep 2025 14:25:40 GMT' ]

// To String
console.log('String', d.toString())
[
  'String',
  'Tue Sep 23 2025 07:25:40 GMT-0700 (Mountain Standard Time)'
]
console.log('DateString', d.toDateString())
[ 'DateString', 'Tue Sep 23 2025' ]
console.log('TimeString', d.toTimeString())
[ 'TimeString', '07:25:40 GMT-0700 (Mountain Standard Time)' ]

// Locale
console.log('LocaleString', d.toLocaleString())
[ 'LocaleString', '9/23/2025, 7:25:40 AM' ]
console.log('LocaleDateString', d.toLocaleDateString())
[ 'LocaleDateString', '9/23/2025' ]
console.log('LocalTimeString', d.toLocaleTimeString())
[ 'LocalTimeString', '7:25:40 AM' ]
```


## Extending the prototype

```js
import {format, relativeTo, relativeToNow} from '@frontierjs/datetime-kit'

Date.prototype.format = function (formatPattern, options) {
   return format(this, formatPattern, options)
}

Date.prototype.relativeTo = function (dateTo, formatPattern, options) {
   return relativeTo(this, dateTo, formatPattern)
}

Date.prototype.relativeToNow = function (formatPattern, options) {
   return relativeToNow(this, new Date(), formatPattern, options)
}
```

