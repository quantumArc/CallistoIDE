'use strict';

/** Arithmetic mean of a non-empty array of numbers. */
function mean(values) {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Middle value of the numbers in sorted order; for an even count, the average of the two middle values. */
function median(values) {
    const sorted = [...values].sort();
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
        return (sorted[middle - 1] + sorted[middle]) / 2;
    }
    return sorted[middle];
}

/** Most frequent value; the smallest of them when several are equally frequent. */
function mode(values) {
    const counts = new Map();
    for (const value of values) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    let best;
    for (const [value, count] of counts) {
        if (best === undefined || count > best.count || (count === best.count && value < best.value)) {
            best = { value, count };
        }
    }
    return best?.value;
}

module.exports = { mean, median, mode };
