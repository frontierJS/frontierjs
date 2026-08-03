// Matches the *.job.ts glob but is not a defineJob() result — autoload must
// warn and skip it rather than registering a broken handler.
export default { name: 'not-a-real-job' }
