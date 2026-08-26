// site/src/routes/vs-laravel.meta.js — the page's 9 code samples.
//
// The Laravel comparison — six PHP samples and three of this framework.
//
// They were marked up BY HAND in the page — a `<b>` around every keyword —
// which put HTML where the code was meant to be. Here they are the source a
// reader would copy, and `@frontierjs/toolbelt/glow` marks them up at build
// time. A companion runs at build only, so the page ships no highlighter.

import { block, sniff } from '../data/code.js'

/* Stated where the sniffer cannot tell — it reads this repo's own
   languages, and these are somebody else's. */
const LANG = {
  S0: 'php',
  S1: 'php',
  S2: 'php',
  S3: 'php',
  S4: 'php',
  S5: 'php',
}

const SAMPLES = {
  S0: `Schema::create('leads', function (Blueprint $table) {
    $table->id();
    $table->foreignId('owner_id')->constrained('users');
    $table->string('name', 200);
    $table->string('email')->unique();
    $table->decimal('value', 10, 2);
    $table->timestamps();
});`,
  S1: `class Lead extends Model {
    protected $fillable = ['name', 'email', 'value'];
    protected $casts    = ['value' => 'decimal:2'];

    public function owner() { return $this->belongsTo(User::class); }
}`,
  S2: `public function rules(): array {
    return [
        'name'  => ['required', 'string', 'max:200'],
        'email' => ['required', 'email', 'unique:leads'],
        'value' => ['required', 'numeric', 'min:0'],
    ];
}`,
  S3: `public function view(User $user, Lead $lead): bool {
    return $lead->owner_id === $user->id;
}
public function create(User $user): bool { return $user->isMember(); }
public function update(User $user, Lead $lead): bool { … }
public function delete(User $user, Lead $lead): bool { return $user->isAdmin(); }`,
  S4: `public function index(Request $request) {
    return LeadResource::collection(
        Lead::where('owner_id', $request->user()->id)   // or a scope
            ->paginate($request->integer('per_page', 20))
    );
}
public function store(StoreLeadRequest $request) {
    $this->authorize('create', Lead::class);
    return new LeadResource(Lead::create($request->validated()));
}
// show, update, destroy…`,
  S5: `Route::apiResource('leads', LeadController::class)
     ->middleware('auth:sanctum');

// then, in an Inertia/SPA frontend:
//  · re-declare the validation rules, or call Precognition
//  · pass \`can\` booleans through as props to hide the buttons`,
  S6: `model Lead {
  id        Int      @id
  ownerId   Int
  name      String   @length(1, 200) @trim
  email     String   @email @unique @lower
  value     Float    @gte(0)
  createdAt DateTime @default(now())

  // read · create · update · delete
  @@gate("0.4.4.5")
  @@allow('read', ownerId == auth().id)
}`,
  S7: `// name  ← this filename   ('leads.service.ts' → /api/leads)
// model ← the service name ('leads' → db.lead)
// db    ← app.db, scoped per request to the calling user
// CRUD · 401s · 400s ← the Model

export function createLeadsService() {
  return createBaseService({})
}`,
  S8: `<script>
  const leads = createResource('leads', {
    coerce: true, blankToNull: true, validate: true,
  })
  await leads.find({ $limit: 20 })
</script>

<table class="table">
  {#each leads.data as lead}
    <tr><td>{lead.name}</td><td>{lead.email}</td></tr>
  {/each}
</table>

{#if leads.can('delete')}
  <button class="btn danger">Delete</button>
{/if}`,
}

export async function load() {
  return {
    samples: Object.fromEntries(Object.entries(SAMPLES).map(
      ([n, src]) => [n, block(src, LANG[n] ?? sniff(src))])),
  }
}
