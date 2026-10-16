// What a payslip was made of, line by line.
//
// Read-only by declaration, exactly as `invoice-lines` and `journal-lines` are.
// It exists separately from the composed `payslips.get` because a payroll
// report sums lines ACROSS payslips — *what did this shop pay in employer NI
// last quarter* — which is the one question a header-scoped read cannot answer.
import { createService } from '@frontierjs/junction'

export default createService({
  model:   'PayslipLine',
  channel: 'payslip-lines',
  methods: ['find', 'get'],
})
