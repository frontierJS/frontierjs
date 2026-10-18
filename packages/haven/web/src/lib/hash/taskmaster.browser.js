// src/taskmaster.browser.js — `#taskmaster` in a browser, the twin of
// `taskmaster.js`. A page runs no command and starts no loop on the machine it
// is open on, so the workshop has a desk and nobody at it, and the kitchen's
// pass takes no `/menu`.
export function checkout() { return null }

export async function proposals() { return [] }

export function running() { return null }

export function startLoop() { throw new Error('a page starts nothing on a machine') }

export async function readyRows() { return [] }

export async function rulings() { return [] }

export function readMenu() { return null }

export function setMenu() { throw new Error('a page keeps no menu on a machine') }

export function clearMenu() {}

export const flagsLine = () => ''

export const MENUS = {}
