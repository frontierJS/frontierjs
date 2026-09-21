export async function load({ params, url, fetch }) {
  // In real usage: const res = await fetch(`/api/leads/${params.leadId}`)
  // Returning static data for test purposes
  return {
    lead: {
      id: params.leadId,
      name: 'Test Lead',
      status: 'new',
    }
  }
}
