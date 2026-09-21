import { count } from '../../cart.js'

export async function load() { return { n: count() } }
