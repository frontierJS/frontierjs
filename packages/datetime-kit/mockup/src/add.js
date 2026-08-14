function add(date, type, value) {
	const self = date

	if (type.constructor === Number)
		return new Date(self.getTime() + (type - type % 1));

	if (value === undefined) {
		var arr = type.split(' ');
		type = arr[1];
		value = exports.parseInt(arr[0]);
	}

	var dt = new Date(self.getTime());

	switch(type) {
		case 's':
		case 'ss':
		case 'sec':
		case 'second':
		case 'seconds':
			dt.setUTCSeconds(dt.getUTCSeconds() + value);
			return dt;
		case 'm':
		case 'mm':
		case 'minute':
		case 'min':
		case 'minutes':
			dt.setUTCMinutes(dt.getUTCMinutes() + value);
			return dt;
		case 'h':
		case 'hh':
		case 'hour':
		case 'hours':
			dt.setUTCHours(dt.getUTCHours() + value);
			return dt;
		case 'd':
		case 'dd':
		case 'day':
		case 'days':
			dt.setUTCDate(dt.getUTCDate() + value);
			return dt;
		case 'w':
		case 'ww':
		case 'week':
		case 'weeks':
			dt.setUTCDate(dt.getUTCDate() + (value * 7));
			return dt;
		case 'M':
		case 'MM':
		case 'month':
		case 'months':
			dt.setUTCMonth(dt.getUTCMonth() + value);
			return dt;
		case 'y':
		case 'yyyy':
		case 'year':
		case 'years':
			dt.setUTCFullYear(dt.getUTCFullYear() + value);
			return dt;
	}

	return dt;
}

export {add}