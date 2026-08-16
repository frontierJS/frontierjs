function extend(date, datePartial) {
	var dt = new Date(date)
	var match = date.match(regexpDATE)

	if (!match) {
		return dt
  }

	for (var i = 0, length = match.length; i < length; i++) {
		var m = match[i];
		var arr, tmp;

		if (m.indexOf(':') !== -1) {

			arr = m.split(':');
			tmp = +arr[0];
			tmp >= 0 && dt.setUTCHours(tmp);

			if (arr[1]) {
				tmp = +arr[1];
				tmp >= 0 && dt.setUTCMinutes(tmp);
			}

			if (arr[2]) {
				tmp = +arr[2];
				tmp >= 0 && dt.setUTCSeconds(tmp);
			}

			continue;
		}

		if (m.indexOf('-') !== -1) {
			arr = m.split('-');

			tmp = +arr[0];
			tmp && dt.setUTCFullYear(tmp);

			if (arr[1]) {
				tmp = +arr[1];
				tmp >= 0 && dt.setUTCMonth(tmp - 1);
			}

			if (arr[2]) {
				tmp = +arr[2];
				tmp >= 0 && dt.setUTCDate(tmp);
			}

			continue;
		}

		if (m.indexOf('.') !== -1) {
			arr = m.split('.');

			if (arr[2]) {
				tmp = +arr[2];
				!isNaN(tmp) && dt.setUTCFullYear(tmp);
			}

			if (arr[1]) {
				tmp = +arr[1];
				!isNaN(tmp) && dt.setUTCMonth(tmp - 1);
			}

			tmp = +arr[0];
			!isNaN(tmp) && dt.setUTCDate(tmp);

			continue;
		}
	}

	return dt;
};

export {extend}