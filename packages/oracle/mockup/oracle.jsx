import { useState, useMemo, useEffect, useRef, Fragment } from 'react'
import * as d3 from 'd3'
import {
  Search,
  Loader2,
  Check,
  X,
  Plus,
  Copy,
  Download,
  ChevronDown,
  ChevronRight,
  AlertCircle,
  BookOpen,
  Compass,
  Tag,
  Sparkles,
  Box,
  Zap,
  Network,
  ArrowLeft,
  Layers
} from 'lucide-react'

const ACTOR_ARCHETYPES = {
  subject: { name: 'Subject', description: 'who the thing exists for' },
  performer: { name: 'Performer', description: 'who does the work' },
  coordinator: { name: 'Coordinator', description: 'who arranges or assigns' },
  author: { name: 'Author', description: 'who created or originated' },
  owner: { name: 'Owner', description: 'who is accountable for it' },
  observer: { name: 'Observer', description: 'who watches without acting' },
  system: { name: 'System', description: 'non-human actor (cron, integration)' }
}

const VERB_HOMES = {
  capture: { name: 'Capture', description: 'Get information into the system' },
  communicate: { name: 'Communicate', description: 'Move information between actors' },
  transform: { name: 'Transform', description: 'Automatic data shape changes' },
  surface: { name: 'Surface', description: 'Make information visible for decisions' },
  other: {
    name: 'Other',
    description:
      "Operational / value / authority concerns that don't fit the four information-flow verbs — coordination of work, value movement, permission and identity boundaries"
  },
  crosscutting: { name: 'Cross-cutting', description: 'Applies across verbs' }
}

const VERB_COLORS = {
  capture: '#7AA8C2',
  communicate: '#A292C0',
  transform: '#C19C84',
  surface: '#92BD80',
  other: '#8A8273',
  crosscutting: '#B5AC9F'
}

// Entity organization is now tier (core vs domain) + category, NOT verb-home.
// Verb-home was a pattern-axis concept that didn't fit entities (entities are
// nouns, not actions). The trigger × verb grid still organizes PATTERNS via
// VERB_HOMES above.
// Object insertion order is iteration order; categories below appear in
// Core → Domain reading order.
const ENTITY_CATEGORIES = {
  identity_access: {
    tier: 'core',
    name: 'Identity & access',
    desc: 'Actors with system access and the containers they belong to'
  },
  capture: {
    tier: 'core',
    name: 'Capture',
    desc: 'Captured records — structured intake, freeform annotation, and people-as-data'
  },
  communication: {
    tier: 'core',
    name: 'Communication',
    desc: 'How messages move between system and people, person-to-person, and via registered routing'
  },
  integration: {
    tier: 'core',
    name: 'Integration',
    desc: 'External system connections — outbound config and inbound payloads'
  },
  read_surfaces: {
    tier: 'core',
    name: 'Read surfaces',
    desc: 'Aggregated, live, and projected read-only outputs'
  },
  operations: {
    tier: 'core',
    name: 'Operations',
    desc: 'Temporal machinery — what can fire (Action), what fired (Event), how stages progress (Flow)'
  },
  meta: {
    tier: 'core',
    name: 'Meta',
    desc: 'Reusable scaffolds and orthogonal classifiers that apply across the catalog'
  },
  service_scheduling: {
    tier: 'domain',
    name: 'Service & scheduling',
    desc: 'Service-business primitives — bookable time, places, work, owned equipment'
  },
  commerce_value: {
    tier: 'domain',
    name: 'Commerce & value',
    desc: 'Transactional primitives — offers, artifacts, value transfer'
  },
  content_public: {
    tier: 'domain',
    name: 'Content & public',
    desc: 'Anything addressable on the open web'
  }
}

const ENTITY_CATALOG = [
  {
    name: 'Form',
    category: 'capture',
    desc: 'A structured input template defining what to collect',
    props: ['fields', 'owner', 'isPublished'],
    neighbors: ['Submission', 'User', 'Contact'],
    example: 'Customer onboarding form, contact form',
    touches: ['communicate'],
    actors: ['author', 'owner'],
    constraints: ['Must have at least one field', 'Owner controls visibility'],
    patterns: ['submission', 'approval']
  },
  {
    name: 'Submission',
    category: 'capture',
    desc: 'An instance of a Form filled out at a specific time',
    props: ['formId', 'data', 'submitterId', 'submittedAt'],
    neighbors: ['Form', 'User', 'Contact', 'Notification'],
    example: 'A specific user completing a contact form',
    touches: ['communicate', 'other'],
    actors: ['author', 'owner', 'system'],
    constraints: ['Cannot be edited after submission', 'Validated against Form schema'],
    transitions: [
      {
        from: 'draft',
        to: 'submitted',
        trigger: 'author submits',
        effects: ['Event', 'Notification']
      },
      {
        from: 'submitted',
        to: 'under_review',
        trigger: 'reviewer picks up',
        effects: ['Event']
      },
      {
        from: 'under_review',
        to: 'approved',
        trigger: 'reviewer approves',
        effects: ['Notification', 'Event']
      },
      {
        from: 'under_review',
        to: 'rejected',
        trigger: 'reviewer rejects',
        effects: ['Notification', 'Event']
      }
    ],
    patterns: ['submission', 'approval']
  },
  {
    name: 'Note',
    category: 'capture',
    desc: 'Free-form captured text, often informal',
    props: ['body', 'author', 'attachedTo'],
    neighbors: ['User', 'Contact', 'Tag'],
    example: 'Internal annotation on a task or visit',
    touches: ['surface'],
    actors: ['author', 'observer'],
    constraints: ['Author can edit, others read-only'],
    patterns: ['audit']
  },
  {
    name: 'Document',
    category: 'commerce_value',
    kinds: ['estimate', 'quote', 'invoice', 'order', 'contract', 'receipt', 'NDA'],
    desc: 'A formal artifact capturing terms, agreements, or transactional state — proposals, demands, contracts, receipts. The `kind` property determines its specific lifecycle and behavior',
    props: [
      'kind',
      'number',
      'recipient',
      'lineItems',
      'total',
      'status',
      'validUntil',
      'dueAt',
      'fileRef'
    ],
    neighbors: ['Document', 'Payment', 'Contact', 'User', 'Offer'],
    example:
      'An invoice, a quote/proposal, a contract, a receipt, an NDA, an order — anything with a number, a recipient, line items, and a state machine',
    touches: ['capture', 'communicate'],
    actors: ['author', 'subject', 'owner', 'system'],
    constraints: [
      'Has a kind (estimate, quote, invoice, order, contract, receipt, NDA, etc.) that determines lifecycle and binding semantics',
      'Versioned on edit before binding',
      'Cannot be modified after reaching a binding state (accepted, paid, signed, executed)',
      'Contains line items — referencing Offers (chosen) or inline charges (fees, taxes, discounts)',
      'Multi-party Documents (contracts) require all parties to reach binding state'
    ],
    transitions: [
      {
        from: 'draft',
        to: 'sent',
        trigger: 'issued to recipient',
        effects: ['Notification']
      },
      { from: 'sent', to: 'viewed', trigger: 'recipient opens', effects: ['Event'] },
      {
        from: 'viewed',
        to: 'accepted',
        trigger: 'recipient accepts terms (quote-kind)',
        effects: ['Event', 'Notification']
      },
      {
        from: 'viewed',
        to: 'declined',
        trigger: 'recipient declines (quote-kind)',
        effects: ['Notification']
      },
      {
        from: 'viewed',
        to: 'executed',
        trigger: 'all parties sign (contract-kind)',
        effects: ['Event', 'Notification']
      },
      {
        from: 'executed',
        to: 'terminated',
        trigger: 'expiry, breach, or mutual termination (contract-kind)',
        effects: ['Event', 'Notification']
      },
      {
        from: 'sent',
        to: 'expired',
        trigger: 'past validUntil (quote-kind)',
        effects: ['Event']
      },
      {
        from: 'sent',
        to: 'paid',
        trigger: 'payment received (invoice-kind)',
        effects: ['Payment', 'Notification']
      },
      {
        from: 'sent',
        to: 'overdue',
        trigger: 'past dueAt (invoice-kind)',
        effects: ['Event', 'Notification']
      },
      {
        from: 'overdue',
        to: 'in_collections',
        trigger: 'escalation threshold (invoice-kind)',
        effects: ['Notification']
      },
      {
        from: 'paid',
        to: 'refunded',
        trigger: 'refund processed (invoice-kind)',
        effects: ['Payment', 'Notification']
      }
    ],
    patterns: ['checkout', 'settlement', 'renewal', 'approval', 'audit']
  },

  {
    name: 'Schedule',
    category: 'service_scheduling',
    desc: 'A plan describing when things happen, often recurring',
    props: ['rule', 'startDate', 'endDate', 'timezone'],
    neighbors: ['Visit', 'Resource', 'User'],
    example: 'Weekly cleaning plan, monthly billing cycle',
    touches: ['communicate', 'transform'],
    actors: ['owner', 'subject', 'system'],
    constraints: ['Cannot overlap conflicting resources', 'Owner can modify'],
    patterns: ['recurring', 'booking']
  },
  {
    name: 'Visit',
    category: 'service_scheduling',
    desc: 'A bounded interaction period with status',
    props: ['scheduledAt', 'status', 'duration', 'participantIds'],
    neighbors: ['Schedule', 'User', 'Contact', 'Resource', 'Notification'],
    example: 'A cleaning appointment, a clinic visit',
    touches: ['capture', 'communicate', 'other'],
    actors: ['subject', 'performer', 'coordinator', 'observer'],
    constraints: [
      'Cannot be scheduled in the past',
      'Must have at least one Performer',
      'Only Coordinator can reassign'
    ],
    transitions: [
      {
        from: 'scheduled',
        to: 'confirmed',
        trigger: 'customer confirms',
        effects: ['Notification']
      },
      {
        from: 'confirmed',
        to: 'in_progress',
        trigger: 'crew starts work',
        effects: ['Event']
      },
      {
        from: 'in_progress',
        to: 'complete',
        trigger: 'crew marks done',
        effects: ['Event', 'Document']
      },
      {
        from: 'scheduled',
        to: 'cancelled',
        trigger: 'customer or admin cancels',
        effects: ['Notification', 'Payment']
      },
      {
        from: 'confirmed',
        to: 'no_show',
        trigger: 'no-one shows at scheduled time',
        effects: ['Notification', 'Document']
      }
    ],
    patterns: ['booking', 'assignment', 'cascade', 'recurring']
  },
  {
    name: 'Task',
    category: 'service_scheduling',
    desc: 'A discrete unit of work assigned to a performer — outcome-bounded (must be done by X), distinct from a Visit which is time-and-place bounded. NOT a cron/queue job — those are the recurring pattern + async modifier acting on Events, not Task instances',
    props: ['title', 'assigneeId', 'status', 'priority', 'dueAt'],
    neighbors: ['Offer', 'User', 'Flow', 'Tag'],
    example:
      'A maintenance ticket, a help-desk ticket, a project task, an internal action item',
    touches: ['communicate', 'other'],
    actors: ['subject', 'performer', 'coordinator'],
    constraints: [
      'Must have an assignee',
      'Status follows defined transitions',
      'Outcome-bounded by dueAt, not time-slot bounded (use Visit for time-slot work)',
      'May be performed against one or more Offers'
    ],
    transitions: [
      {
        from: 'backlog',
        to: 'assigned',
        trigger: 'coordinator routes work',
        effects: ['Notification']
      },
      { from: 'assigned', to: 'accepted', trigger: 'performer accepts', effects: ['Event'] },
      {
        from: 'assigned',
        to: 'reassigned',
        trigger: 'performer declines or times out',
        effects: ['Notification']
      },
      {
        from: 'accepted',
        to: 'in_progress',
        trigger: 'performer starts',
        effects: ['Event']
      },
      {
        from: 'in_progress',
        to: 'completed',
        trigger: 'performer marks done',
        effects: ['Event']
      },
      {
        from: 'any',
        to: 'cancelled',
        trigger: 'coordinator cancels',
        effects: ['Notification']
      }
    ],
    patterns: ['assignment', 'cascade', 'escalation']
  },
  {
    name: 'Flow',
    category: 'operations',
    desc: 'A sequence of stages or steps things move through. Spans verbs — stages may include capture, communicate, or surface activity. Distinct from Task (a single unit of work) and Cascade (the dynamic propagation of state changes); a Flow is the *definition* of the stage progression, instances flow through it',
    props: ['stages', 'transitions', 'currentStage'],
    neighbors: ['Task', 'Event', 'Template'],
    example: 'Lead pipeline stages, approval chain, content publishing flow, onboarding flow',
    touches: ['other', 'surface', 'communicate'],
    actors: ['coordinator', 'system'],
    constraints: ['Transitions follow rules', 'Owner controls stage definitions'],
    patterns: ['cascade', 'approval']
  },
  {
    name: 'Resource',
    category: 'service_scheduling',
    desc: 'A bookable or assignable thing with capacity',
    props: ['name', 'capacity', 'availability', 'type'],
    neighbors: ['Schedule', 'Visit', 'Task'],
    example: 'A meeting room, a crew, equipment',
    touches: ['surface'],
    actors: ['coordinator', 'performer'],
    constraints: ['Capacity is finite', 'Conflicts must be detected'],
    patterns: ['booking', 'assignment']
  },

  {
    name: 'Message',
    category: 'communication',
    desc: 'A single piece of communication, point-to-point or broadcast. Threading is implicit via parentMessageId — a conversation is a chain of Messages, not a separate entity',
    props: ['body', 'senderId', 'recipientId', 'channel', 'parentMessageId', 'subject'],
    neighbors: ['User', 'Contact'],
    example:
      'A chat message, an email, an SMS — replies link via parentMessageId to form conversations',
    touches: ['capture', 'other'],
    actors: ['author', 'subject', 'observer'],
    constraints: [
      'Has a sender and recipient(s)',
      'Channel-specific format',
      'Threading is implicit via parentMessageId; no separate Thread entity'
    ],
    patterns: ['notification', 'outreach']
  },
  {
    name: 'Notification',
    category: 'communication',
    desc: 'A system-generated alert or update to a recipient',
    props: ['recipientId', 'kind', 'payload', 'sentAt'],
    neighbors: ['User', 'Contact', 'Listener', 'Event'],
    example:
      'A booking confirmation, a payment receipt, a deadline alert, a password reset email',
    touches: ['transform'],
    actors: ['subject', 'system'],
    constraints: ['Has a recipient', 'Generated by Event, not human'],
    patterns: ['notification', 'cascade']
  },
  {
    name: 'Listener',
    category: 'communication',
    desc: 'A registered interest in a topic or event stream — durable record routing future events to a recipient or endpoint',
    props: ['actorId', 'topic', 'channel', 'endpoint', 'isActive', 'createdAt'],
    neighbors: ['User', 'Contact', 'Notification', 'Event'],
    example:
      'Email digest opt-in, webhook registration, Slack channel subscription, push-notification consent',
    touches: ['other'],
    actors: ['subject', 'system'],
    constraints: [
      'Listener can be deactivated (unsubscribed)',
      'Active state required for delivery',
      'Endpoint or actor required (one or the other)'
    ],
    patterns: ['notification']
  },

  {
    name: 'Offer',
    category: 'commerce_value',
    desc: "What's being sold to a customer — a service, product, or package they CHOOSE. Used as a template or referenced as a line item on Documents. Note: imposed charges (cancellation fees, late fees, taxes, discounts) are NOT Offers — they are inline line items on Documents with no entity backing",
    props: ['type', 'name', 'price', 'unit', 'mode', 'isTemplate', 'parentId'],
    neighbors: ['Document', 'Task'],
    example:
      'A house cleaning service, a fertilizer bag, a lawn care package, a subscription tier',
    touches: ['capture', 'other', 'surface'],
    actors: ['owner', 'subject', 'author'],
    constraints: [
      'Pricing mode determines required fields (price for flat, rate for hourly, perUnit for quantity-based)',
      'Templates spawn line-item instances when referenced as line items on Documents or attached to Tasks',
      'Packages compose child offers via parent relationship'
    ],
    patterns: ['settlement', 'recurring']
  },
  {
    name: 'Payment',
    category: 'commerce_value',
    desc: 'A transfer of value with a timestamp',
    props: ['amount', 'currency', 'method', 'status'],
    neighbors: ['Document', 'Contact'],
    example: 'A charge, a refund, a payout',
    touches: ['other', 'communicate'],
    actors: ['subject', 'owner', 'system'],
    constraints: ['Irreversible without explicit refund', 'Auditable always'],
    transitions: [
      {
        from: 'initiated',
        to: 'processing',
        trigger: 'payment method charged',
        effects: ['Event']
      },
      {
        from: 'processing',
        to: 'succeeded',
        trigger: 'gateway confirms',
        effects: ['Event', 'Notification', 'Document']
      },
      {
        from: 'processing',
        to: 'failed',
        trigger: 'gateway rejects',
        effects: ['Event', 'Notification']
      },
      {
        from: 'succeeded',
        to: 'refunded',
        trigger: 'refund issued',
        effects: ['Event', 'Notification']
      },
      {
        from: 'succeeded',
        to: 'disputed',
        trigger: 'chargeback initiated by payer',
        effects: ['Event', 'Notification']
      }
    ],
    patterns: ['settlement', 'cascade', 'audit']
  },

  {
    name: 'Report',
    category: 'read_surfaces',
    desc: 'A generated snapshot of data for human consumption',
    props: ['title', 'generatedAt', 'parameters', 'body'],
    neighbors: ['Dashboard', 'View'],
    example: 'A monthly revenue report',
    touches: ['transform', 'communicate'],
    actors: ['observer', 'owner', 'system'],
    constraints: ['Reflects data at time of generation', 'May be parameterized'],
    patterns: ['recurring', 'notification']
  },
  {
    name: 'Dashboard',
    category: 'read_surfaces',
    desc: 'A live aggregated view for decision-making',
    props: ['widgets', 'filters', 'refreshInterval'],
    neighbors: ['Report', 'View'],
    example: 'Sales pipeline dashboard, system health',
    touches: ['transform'],
    actors: ['observer', 'owner'],
    constraints: ['Updates on refresh or schedule'],
    patterns: []
  },
  {
    name: 'View',
    category: 'read_surfaces',
    desc: 'A persisted way of looking at a slice of data',
    props: ['name', 'filter', 'sort', 'columns'],
    neighbors: ['Report', 'Dashboard'],
    example: 'A saved filter, custom list view',
    touches: ['other'],
    actors: ['owner', 'observer'],
    constraints: ['Scoped by owner permissions'],
    patterns: []
  },

  {
    name: 'Webhook',
    category: 'integration',
    desc: 'An inbound event triggering processing',
    props: ['source', 'endpoint', 'payload', 'receivedAt'],
    neighbors: ['Integration', 'Event'],
    example: 'Stripe payment webhook, GitHub push hook',
    touches: ['capture', 'other'],
    actors: ['system'],
    constraints: ['Source must be authenticated', 'Idempotency expected'],
    patterns: ['webhook_ingress', 'audit']
  },
  {
    name: 'Integration',
    category: 'integration',
    desc: 'A bridge between two systems — owns auth, field mappings, and sync cadence',
    props: [
      'sourceSystem',
      'targetSystem',
      'authConfig',
      'fieldMappings',
      'cadence',
      'lastRunAt',
      'status'
    ],
    neighbors: ['Webhook', 'Event'],
    example: 'Maid.Tech ↔ TCS connector, Stripe webhook receiver, QuickBooks sync',
    touches: ['communicate', 'other'],
    actors: ['owner', 'system'],
    constraints: [
      'Auth credentials are scoped',
      'Failure modes must be observable',
      'Field mappings versioned with the integration'
    ],
    patterns: ['webhook_ingress', 'batch_sync']
  },

  {
    name: 'User',
    category: 'identity_access',
    desc: 'A human (or service account) granted authenticated access to interact with the system',
    props: ['email', 'roleId', 'lastSeenAt', 'authProvider'],
    neighbors: ['Role', 'Organization', 'Event', 'Contact'],
    example: 'A logged-in admin, a crew member with a portal account',
    touches: ['communicate', 'capture', 'other'],
    actors: ['author', 'owner', 'performer', 'coordinator'],
    constraints: ['Unique email', 'Belongs to at most one Org', 'Has at least one Role'],
    patterns: []
  },
  {
    name: 'Contact',
    category: 'capture',
    kinds: ['customer', 'lead', 'prospect'],
    desc: 'A descriptive record of a person — captured for CRM, communication, or transaction, with no access to the system itself',
    props: ['name', 'email', 'phone', 'tags', 'source'],
    neighbors: ['User', 'Organization', 'Note', 'Message'],
    example:
      'A customer record, a lead in pipeline, a prospect, an unauthenticated payer — kinds: customer / lead / prospect',
    touches: ['communicate', 'other'],
    actors: ['subject'],
    constraints: [
      'No authenticated access by default',
      'May be linked to a User if they later sign up'
    ],
    transitions: [
      {
        from: 'new',
        to: 'qualified',
        trigger: 'criteria met (engagement, fit)',
        effects: ['Event']
      },
      {
        from: 'qualified',
        to: 'active',
        trigger: 'first transaction or signup',
        effects: ['Document', 'Event']
      },
      {
        from: 'active',
        to: 'inactive',
        trigger: 'no activity for threshold period',
        effects: ['Event']
      },
      {
        from: 'active',
        to: 'churned',
        trigger: 'explicit cancellation or unsubscribe',
        effects: ['Event', 'Notification']
      },
      {
        from: 'any',
        to: 'blocked',
        trigger: 'admin blocks or marks fraudulent',
        effects: ['Event']
      }
    ],
    patterns: []
  },
  {
    name: 'Role',
    category: 'identity_access',
    desc: 'A permission set assignable to a Person',
    props: ['name', 'permissions', 'isSystem'],
    neighbors: ['User', 'Organization'],
    example: 'Admin, viewer, dispatcher',
    touches: [],
    actors: ['owner', 'system'],
    constraints: ['Permissions are explicit', 'System roles cannot be deleted'],
    patterns: []
  },
  {
    name: 'Organization',
    category: 'identity_access',
    desc: 'A multi-person container or tenant',
    props: ['name', 'planTier', 'createdAt'],
    neighbors: ['User', 'Contact', 'Role', 'Document'],
    example: 'A customer company, a tenant workspace',
    touches: ['other'],
    actors: ['owner', 'observer'],
    constraints: ['Has at least one Owner', 'Settings cascade to members'],
    patterns: []
  },
  {
    name: 'Group',
    category: 'identity_access',
    desc: 'A named collection of members — Users (a team), Contacts (a segment), or both (mixed). Provides a stable recipient set, scope boundary, or behavioral category that other patterns reference. Distinct from Organization (tenant boundary with billing/plan), Tag (flat label applied to entities), and Listener (registered interest in an event stream, one actor per record)',
    props: [
      'name',
      'type',
      'status',
      'visibility',
      'memberType',
      'isDynamicMembership',
      'membershipRules',
      'ownerId'
    ],
    neighbors: [
      'User',
      'Contact',
      'Notification',
      'Listener',
      'Organization',
      'Tag',
      'Report'
    ],
    example:
      'A sales team (Users), a VIP customer segment (Contacts), an email newsletter list, a support escalation channel, a mixed group of staff plus key clients',
    touches: ['communicate', 'surface', 'other'],
    actors: ['owner', 'coordinator', 'observer'],
    constraints: [
      'Has a name and an owning Account or Organization',
      'Members may be Users, Contacts, or mixed (heterogeneous)',
      'Membership may be static (explicit roster) or dynamic (rule-driven)',
      'Visibility scoped (private, shared, public) — controls who can see and target the group'
    ],
    transitions: [
      {
        from: 'draft',
        to: 'active',
        trigger: 'owner activates the group',
        effects: ['Event']
      },
      { from: 'active', to: 'inactive', trigger: 'owner pauses', effects: ['Event'] },
      { from: 'inactive', to: 'active', trigger: 'owner reactivates', effects: ['Event'] },
      { from: 'any', to: 'archived', trigger: 'owner soft-deletes', effects: ['Event'] }
    ],
    patterns: []
  },

  {
    name: 'Tag',
    category: 'meta',
    desc: 'A classification applied to any entity',
    props: ['name', 'color', 'scope'],
    neighbors: ['User', 'Contact', 'Organization'],
    example: 'A label, a category, a hashtag',
    touches: ['surface'],
    actors: ['author', 'owner'],
    constraints: ['Scope determines applicability'],
    patterns: []
  },
  {
    name: 'Location',
    category: 'service_scheduling',
    desc: 'A place where things happen',
    props: ['name', 'address', 'lat', 'lng', 'timezone'],
    neighbors: ['Visit', 'User', 'Contact', 'Resource'],
    example: 'A customer property, an office',
    touches: ['other'],
    actors: ['subject', 'performer'],
    constraints: ['Geocoded for mapping'],
    patterns: []
  },
  {
    name: 'Event',
    category: 'operations',
    kinds: ['domain', 'audit'],
    desc: 'A point-in-time internal occurrence — something that happened, recorded for downstream reaction AND for forensic/compliance traceability. Events are the universal record: domain occurrences, state changes, user activity, system signals, action outcomes, and audit entries. There is no separate AuditLog entity — compliance-grade audit trails are simply Events with actor and retention semantics',
    props: [
      'kind',
      'actorId',
      'subjectRef',
      'occurredAt',
      'payload',
      'sourceActionId',
      'severity'
    ],
    neighbors: ['Notification', 'Webhook', 'Action', 'User'],
    example:
      'DocumentSent, VisitMarkedComplete, PaymentSucceeded, ActionFailed, AdminLoggedIn (audit flavor), RoleChanged (audit flavor)',
    touches: ['other', 'communicate', 'capture'],
    actors: ['system'],
    constraints: [
      'Immutable once written',
      'Has a timestamp',
      'May reference a source Action when produced by command execution',
      'When used as audit trail, must be append-only and retained per policy'
    ],
    patterns: ['cascade', 'notification', 'audit']
  },
  {
    name: 'Template',
    category: 'meta',
    desc: 'A reusable starting pattern',
    props: ['name', 'body', 'variables', 'kind'],
    neighbors: ['Document', 'Integration', 'Flow'],
    example: 'Email template, contract template',
    touches: ['capture'],
    actors: ['owner', 'author'],
    constraints: ['Variables must resolve at instantiation'],
    patterns: ['recurring']
  },
  {
    name: 'Asset',
    category: 'service_scheduling',
    desc: 'An owned or tracked item with provenance and lifecycle — equipment, vehicles, inventory, digital files. Distinct from Resource (bookable/assignable) by emphasizing ownership and tracking over coordination',
    props: [
      'name',
      'type',
      'serialNumber',
      'ownerId',
      'acquiredAt',
      'value',
      'condition',
      'location'
    ],
    neighbors: ['Resource', 'Document', 'User', 'Organization', 'Event'],
    example:
      'A company vehicle, a piece of equipment, an inventory item, a tracked digital file',
    touches: ['other', 'surface'],
    actors: ['owner', 'subject', 'observer'],
    constraints: [
      'Has an owner',
      'Tracked over time with audit history',
      'May or may not also be a Resource (if bookable)'
    ],
    transitions: [
      { from: 'acquired', to: 'in_service', trigger: 'deployed for use', effects: ['Event'] },
      {
        from: 'in_service',
        to: 'maintenance',
        trigger: 'scheduled or unscheduled service',
        effects: ['Event', 'Notification']
      },
      {
        from: 'maintenance',
        to: 'in_service',
        trigger: 'service complete',
        effects: ['Event']
      },
      {
        from: 'in_service',
        to: 'retired',
        trigger: 'end of useful life',
        effects: ['Event']
      },
      {
        from: 'any',
        to: 'disposed',
        trigger: 'sold, lost, or written off',
        effects: ['Event']
      }
    ],
    patterns: ['audit', 'escalation']
  },
  {
    name: 'Page',
    category: 'content_public',
    desc: 'Addressable content within a Site — a presented view at a URL',
    props: ['slug', 'title', 'body', 'siteId', 'status', 'publishedAt', 'authorId'],
    neighbors: ['Site', 'User', 'Tag', 'Form'],
    example: 'A landing page, a service page, a blog post, a docs page, a product page',
    touches: ['capture', 'communicate'],
    actors: ['author', 'owner', 'observer'],
    constraints: [
      'Belongs to a Site',
      'Has a slug unique within the Site',
      'Can be draft or published'
    ],
    transitions: [
      {
        from: 'draft',
        to: 'published',
        trigger: 'author publishes',
        effects: ['Event', 'Notification']
      },
      { from: 'published', to: 'unpublished', trigger: 'taken offline', effects: ['Event'] },
      { from: 'unpublished', to: 'published', trigger: 'republished', effects: ['Event'] },
      { from: 'any', to: 'archived', trigger: 'removed permanently', effects: ['Event'] }
    ],
    patterns: ['outreach', 'submission']
  },
  {
    name: 'Site',
    category: 'content_public',
    desc: 'A web-addressable boundary — domain, branding, configuration, and the collection of Pages it contains. The container that defines a presentation context, analogous to Organization but for web presence',
    props: ['domain', 'name', 'branding', 'configuration', 'ownerId', 'status'],
    neighbors: ['Page', 'Organization', 'User', 'Integration'],
    example:
      'A client website, a marketing site, a documentation portal, a multi-tenant app instance',
    touches: ['surface', 'capture'],
    actors: ['owner', 'observer'],
    constraints: [
      'Has a unique domain',
      'Owned by an Organization or User',
      'Contains Pages'
    ],
    transitions: [
      {
        from: 'draft',
        to: 'published',
        trigger: 'launched to public',
        effects: ['Event', 'Notification']
      },
      {
        from: 'published',
        to: 'maintenance',
        trigger: 'taken down for work',
        effects: ['Event']
      },
      { from: 'maintenance', to: 'published', trigger: 'back online', effects: ['Event'] },
      { from: 'any', to: 'archived', trigger: 'decommissioned', effects: ['Event'] }
    ],
    patterns: ['audit']
  },
  {
    name: 'Action',
    category: 'operations',
    desc: "An invokable, scheduled, or executing operation — the system's commands with full execution lifecycle. Distinct from Event (past-tense observation) in that an Action has intent, timing, retry semantics, and execution state. Action is what the system can DO; Event is what has HAPPENED. Actions produce Events as they execute",
    props: [
      'name',
      'type',
      'source',
      'target',
      'status',
      'executeAt',
      'priority',
      'retries',
      'timeout',
      'data'
    ],
    neighbors: ['Event', 'User'],
    example:
      'A "Send Reminder" command queued for 9am, a "Refund Payment" invocation, a "Sync Customer to QuickBooks" scheduled job with retry policy, a "Cancel Booking" admin action',
    touches: ['other', 'communicate'],
    actors: ['author', 'owner', 'system'],
    constraints: [
      'Has a type and a target',
      'Produces Events on state change',
      'Schedulable via executeAt; retryable per policy',
      'Cancellable before completion'
    ],
    transitions: [
      {
        from: 'pending',
        to: 'scheduled',
        trigger: 'executeAt set or queued',
        effects: ['Event']
      },
      {
        from: 'scheduled',
        to: 'running',
        trigger: 'worker picks up the action',
        effects: ['Event']
      },
      {
        from: 'running',
        to: 'success',
        trigger: 'completed without error',
        effects: ['Event']
      },
      {
        from: 'running',
        to: 'error',
        trigger: 'execution failed',
        effects: ['Event', 'Notification']
      },
      { from: 'error', to: 'scheduled', trigger: 'retry policy fires', effects: ['Event'] },
      {
        from: 'any',
        to: 'cancelled',
        trigger: 'cancelled before completion',
        effects: ['Event']
      },
      { from: 'running', to: 'paused', trigger: 'paused mid-execution', effects: ['Event'] },
      { from: 'paused', to: 'running', trigger: 'resumed', effects: ['Event'] }
    ],
    patterns: ['cascade', 'audit']
  }
]

const ENTITY_CATALOG_NAMES = new Set(ENTITY_CATALOG.map((e) => e.name))
const entityBase = (name) => (typeof name === 'string' ? name.split(':')[0].trim() : name)
const entityKind = (name) => {
  if (typeof name !== 'string' || !name.includes(':')) return null
  return name.split(':').slice(1).join(':').trim() || null
}
const isInCatalog = (name) => ENTITY_CATALOG_NAMES.has(entityBase(name))

// Deduped union of entities across all flows (preserves first-seen order)
const unionFlowEntities = (flows) => {
  const seen = new Set()
  const out = []
  ;(flows || []).forEach((f) =>
    (f.entities || []).forEach((e) => {
      if (!seen.has(e)) {
        seen.add(e)
        out.push(e)
      }
    })
  )
  return out
}

const TRIGGERS = {
  user: {
    name: 'User',
    desc: 'A person initiates the pattern by acting (submit, click, request)'
  },
  time: { name: 'Time', desc: 'A schedule, deadline, or cadence fires the pattern' },
  state: {
    name: 'State',
    desc: 'An entity state change inside the system fires the pattern'
  },
  external: {
    name: 'External',
    desc: 'A third-party system or signal arriving from outside fires the pattern'
  }
}

// ── Grammar verb controlled vocabulary ─────────────────────────────────────
// 11 verbs, each locked to a signature: boundary (does data cross the system
// edge?) × persistence (does MY stored state change?). The verb stays a readable
// word; the signature drives the visual treatment. See grammar-verb-spec.md.
// `voice` distinguishes the two inbound-mutating synonyms (submit = actor voice,
// receive = system voice). `forms` lists inflections for the tokenizer.
const VERB_SIGNATURES = {
  // INTERNAL — no edge crossing
  read: { boundary: 'internal', persistence: 'reads', forms: ['read', 'reads', 'reading'] },
  create: {
    boundary: 'internal',
    persistence: 'mutates',
    forms: ['create', 'creates', 'created', 'creating']
  },
  update: {
    boundary: 'internal',
    persistence: 'mutates',
    forms: ['update', 'updates', 'updated', 'updating']
  },
  transition: {
    boundary: 'internal',
    persistence: 'mutates',
    forms: ['transition', 'transitions', 'transitioned', 'transitioning']
  },
  // INBOUND — data enters
  submit: {
    boundary: 'in',
    persistence: 'mutates',
    voice: 'actor',
    forms: ['submit', 'submits', 'submitted', 'submitting']
  },
  receive: {
    boundary: 'in',
    persistence: 'mutates',
    voice: 'system',
    forms: ['receive', 'receives', 'received', 'receiving']
  },
  fetch: {
    boundary: 'in',
    persistence: 'reads',
    forms: ['fetch', 'fetches', 'fetched', 'fetching']
  },
  // OUTBOUND — data leaves
  send: {
    boundary: 'out',
    persistence: 'reads',
    forms: ['send', 'sends', 'sent', 'sending']
  },
  publish: {
    boundary: 'out',
    persistence: 'mutates',
    forms: ['publish', 'publishes', 'published', 'publishing']
  },
  // EXCHANGE — both directions in one operation
  sync: {
    boundary: 'exchange',
    persistence: 'mutates',
    forms: ['sync', 'syncs', 'synced', 'syncing']
  },
  consult: {
    boundary: 'exchange',
    persistence: 'reads',
    forms: ['consult', 'consults', 'consulted', 'consulting']
  }
}

// form (lowercase) → { base, boundary, persistence, voice? }
const VERB_FORM_LOOKUP = {}
Object.entries(VERB_SIGNATURES).forEach(([base, sig]) => {
  sig.forms.forEach((f) => {
    VERB_FORM_LOOKUP[f.toLowerCase()] = { base, ...sig }
  })
})
// All forms, longest-first (defensive; \b already guards partial matches)
const VERB_ALTERNATION = Object.keys(VERB_FORM_LOOKUP)
  .sort((a, b) => b.length - a.length)
  .join('|')

// boundary → accent color + directional glyph (tool dark-theme palette)
const VERB_BOUNDARY_STYLE = {
  internal: { color: '#B5AC9F', glyph: '' },
  in: { color: '#7AA8C2', glyph: '↓' },
  out: { color: '#D49852', glyph: '↑' },
  exchange: { color: '#7F77DD', glyph: '⇅' }
}

const PATTERN_CATALOG = [
  // ─── USER-initiated ──────────────────────────────────────────────────────
  {
    id: 'submission',
    name: 'Submission',
    trigger: 'user',
    verb: 'capture',
    touches_verbs: ['communicate'],
    desc: 'An author fills out a structured input and the system creates a record',
    grammar: 'Author submits [Form] → creates [Submission]',
    actors: ['author', 'owner'],
    entities: ['Form', 'Submission', 'Notification'],
    variations: [
      'Anonymous vs authenticated',
      'Multi-step (wizard) vs single-page',
      'Saved drafts vs single submit'
    ]
  },
  {
    id: 'booking',
    name: 'Booking',
    trigger: 'user',
    verb: 'other',
    touches_verbs: ['capture'],
    desc: 'A subject reserves a resource for a time period, producing a scheduled interaction',
    grammar:
      'Subject submits booking → creates [Visit] referencing [Resource] and [Schedule]',
    actors: ['subject', 'coordinator', 'performer'],
    entities: ['Visit', 'Schedule', 'Resource', 'Contact'],
    variations: [
      'Self-service vs mediated',
      'One-time vs recurring',
      'Public booking vs private/invite-only'
    ]
  },
  {
    id: 'assignment',
    name: 'Assignment',
    trigger: 'user',
    verb: 'other',
    touches_verbs: ['communicate'],
    desc: 'A coordinator routes work to a performer',
    grammar:
      'Coordinator updates [Task] or [Visit] assignee → transitions to assigned → sends [Notification] to the Performer',
    actors: ['coordinator', 'performer'],
    entities: ['Task', 'Visit', 'User', 'Notification'],
    variations: [
      'Manual vs round-robin auto-assign',
      'Accept/reject workflow',
      'Reassignment allowed mid-work'
    ]
  },
  {
    id: 'outreach',
    name: 'Outreach',
    trigger: 'user',
    verb: 'communicate',
    touches_verbs: ['capture'],
    desc: 'An actor initiates direct communication to a recipient outside the system',
    grammar:
      'Author creates [Message] → sends [Message] to the Contact → reply [Message] chains via parentMessageId',
    actors: ['author', 'owner'],
    entities: ['Message', 'Contact'],
    variations: ['Cold vs warm', '1-to-1 vs broadcast', 'Sequenced (drip) vs single send']
  },
  {
    id: 'checkout',
    name: 'Checkout',
    trigger: 'user',
    verb: 'other',
    touches_verbs: ['communicate', 'capture'],
    desc: 'A user commits to a value exchange — accepts a Document (quote), creates a follow-on Document (invoice or order kind), captures a Payment',
    grammar:
      'Subject transitions [Document:quote] to accepted → creates [Document:invoice] or [Document:order] → creates [Payment]',
    actors: ['subject', 'owner', 'system'],
    entities: ['Document', 'Payment', 'Notification'],
    variations: [
      'One-time vs subscription',
      'Card vs invoice (net-N)',
      'Guest vs authenticated checkout'
    ]
  },
  {
    id: 'search',
    name: 'Search',
    trigger: 'user',
    verb: 'surface',
    touches_verbs: [],
    desc: 'A user requests a filtered view of data on demand',
    grammar: 'Subject reads matching [Entities] with filters',
    actors: ['subject', 'observer'],
    entities: [],
    variations: [
      'Full-text vs faceted',
      'Real-time vs pre-indexed',
      'Personalized vs uniform results'
    ]
  },
  {
    id: 'approval',
    name: 'Approval',
    trigger: 'user',
    verb: 'other',
    touches_verbs: ['capture', 'communicate'],
    desc: 'An author submits something for review; a coordinator approves or rejects',
    grammar:
      'Author submits [Submission] → Coordinator transitions [Submission] to approved or rejected → sends [Notification] to the Author',
    actors: ['author', 'coordinator', 'observer'],
    entities: ['Submission', 'Notification', 'Event'],
    variations: [
      'Single approver vs chain',
      'Auto-approval below threshold',
      'Async vs synchronous'
    ]
  },

  // ─── TIME-initiated ──────────────────────────────────────────────────────
  {
    id: 'recurring',
    name: 'Recurring',
    trigger: 'time',
    verb: 'other',
    touches_verbs: [],
    desc: 'A schedule generates instances on a cadence',
    grammar: '[Schedule] creates [Visit] or [Task] on cadence',
    actors: ['system', 'subject', 'performer'],
    entities: ['Schedule', 'Visit', 'Task'],
    variations: [
      'Fixed cadence vs cron-based',
      'Holiday-aware',
      'Auto-cancel vs requires acceptance'
    ]
  },
  {
    id: 'digest',
    name: 'Digest',
    trigger: 'time',
    verb: 'communicate',
    touches_verbs: ['surface'],
    desc: 'A scheduled rollup of recent activity is delivered to subscribers',
    grammar:
      '[Schedule] fires → reads [Event] history over period → sends [Notification] via matching [Listener]',
    actors: ['subject', 'system'],
    entities: ['Schedule', 'Event', 'Notification'],
    variations: ['Daily vs weekly cadence', 'Personalized vs broadcast', 'Opt-in vs default']
  },
  {
    id: 'renewal',
    name: 'Renewal',
    trigger: 'time',
    verb: 'other',
    touches_verbs: ['communicate'],
    desc: 'A time-bound commitment cycles to its next period, generating a new charge',
    grammar: '[Schedule] fires at renewal → creates [Document:invoice] → creates [Payment]',
    actors: ['subject', 'system', 'owner'],
    entities: ['Schedule', 'Document', 'Payment', 'Notification'],
    variations: [
      'Auto-renew vs opt-in',
      'Tier upgrade at renewal',
      'Pro-rated mid-cycle changes'
    ]
  },
  {
    id: 'batch_sync',
    name: 'Batch sync',
    trigger: 'time',
    verb: 'transform',
    touches_verbs: ['other'],
    desc: 'A scheduled job aligns data between sources on a cadence',
    grammar:
      '[Schedule] fires → [Integration] syncs data via fieldMappings → creates [Event] per record',
    actors: ['system', 'owner'],
    entities: ['Integration', 'Event'],
    variations: [
      'Full vs incremental',
      'One-way vs bidirectional',
      'Conflict resolution rules'
    ]
  },
  {
    id: 'escalation',
    name: 'Escalation',
    trigger: 'time',
    verb: 'other',
    touches_verbs: ['other', 'communicate'],
    desc: 'Time elapses without action; escalates to higher-tier actor',
    grammar:
      '[Task] or [Visit] reaches stale threshold → sends [Notification] to the Coordinator → updates assignee',
    actors: ['system', 'coordinator', 'performer'],
    entities: ['Task', 'Visit', 'Notification'],
    variations: [
      'Single-tier vs multi-tier',
      'Auto-reassign vs manual intervention',
      'SLA-driven thresholds'
    ]
  },

  // ─── STATE-initiated ─────────────────────────────────────────────────────
  {
    id: 'cascade',
    name: 'Cascade',
    trigger: 'state',
    verb: 'other',
    touches_verbs: ['communicate', 'other'],
    desc: 'An entity state change drives a chain of downstream coordination — status changes, assignments, related entity updates. Generalizes the older status_transition and cancellation patterns',
    grammar:
      '[Entity] transitions to [new state] → updates related [Entities] → sends [Notification]',
    actors: ['system', 'performer', 'coordinator'],
    entities: ['Event', 'Notification'],
    variations: [
      'Synchronous vs queued downstream',
      'One-directional vs reversible',
      'Branching vs linear',
      'Cancellation cascade (reverses commitments)'
    ]
  },
  {
    id: 'notification',
    name: 'Notification',
    trigger: 'state',
    verb: 'communicate',
    touches_verbs: [],
    desc: 'A state change produces a delivered message to interested actors',
    grammar: '[Event] fires → reads matching [Listener] → sends [Notification]',
    actors: ['subject', 'observer', 'system'],
    entities: ['Event', 'Notification', 'Listener'],
    variations: [
      'Push vs digest',
      'Personalized vs broadcast',
      'Listener-driven vs rule-driven recipients',
      'Suppression / do-not-disturb rules'
    ]
  },
  {
    id: 'settlement',
    name: 'Settlement',
    trigger: 'state',
    verb: 'other',
    touches_verbs: ['communicate'],
    desc: 'An entity state change drives value movement — billing, refund, credit application',
    grammar:
      '[Entity] transitions to settlement state → creates [Document:invoice] → creates [Payment] → sends [Notification]',
    actors: ['subject', 'owner', 'system'],
    entities: ['Document', 'Payment', 'Notification'],
    variations: [
      'Settle on completion vs net-N',
      'Refund vs charge direction',
      'Multi-party splits',
      'Reversal on cancellation'
    ]
  },
  {
    id: 'projection',
    name: 'Projection',
    trigger: 'state',
    verb: 'transform',
    touches_verbs: ['surface'],
    desc: 'State changes rebuild a derived view — dashboard rollup, materialized read model, search index',
    grammar: '[Event] fires → updates [View]',
    actors: ['system'],
    entities: ['Event'],
    variations: [
      'Eventual vs immediate consistency',
      'Full rebuild vs incremental',
      'Multiple projections per entity'
    ]
  },
  {
    id: 'audit',
    name: 'Audit',
    trigger: 'state',
    verb: 'other',
    touches_verbs: ['capture'],
    desc: 'Every meaningful action is recorded for traceability as an immutable Event with actor and target references. There is no separate AuditLog entity — audit-grade trails are Events with retention semantics',
    grammar: 'Any action on [Entity] → creates [Event:audit]',
    actors: ['system'],
    entities: ['Event'],
    variations: [
      'Verbose vs minimal logging',
      'Compliance-grade (immutable) vs basic',
      'Append-only DB vs cold storage'
    ]
  },

  // ─── EXTERNAL-initiated ──────────────────────────────────────────────────
  {
    id: 'webhook_ingress',
    name: 'Webhook ingress',
    trigger: 'external',
    verb: 'transform',
    touches_verbs: ['capture', 'other'],
    desc: 'An external system sends an event; processed and reflected internally',
    grammar: '[Integration] receives inbound payload → creates [Webhook] → updates [Entity]',
    actors: ['system'],
    entities: ['Webhook', 'Integration', 'Event'],
    variations: [
      'Idempotent vs at-least-once',
      'Synchronous reply vs async',
      'Auth via signature vs token'
    ]
  }
]

// MODIFIERS are NOT base patterns — they are qualifiers that overlay onto a base pattern.
// e.g. 'listener' overlays a fan-out via a registered-interest list onto Notification or Digest.
// 'cancellation' overlays a reverse-direction Cascade. They were previously listed as
// separate patterns; now they are correctly classified as orthogonal modifiers.
const MODIFIERS = [
  {
    id: 'listener',
    name: 'Listener',
    desc: 'Fan-out delivery via a registered-interest list — actors or endpoints register as listeners on a topic, and matching events deliver to all active listeners',
    applies_to: ['notification', 'digest']
  },
  {
    id: 'cancellation',
    name: 'Cancellation',
    desc: 'Reverse-direction Cascade — undo or compensate a prior commitment, often with refund and notification',
    applies_to: ['cascade', 'settlement']
  },
  {
    id: 'idempotency',
    name: 'Idempotency',
    desc: 'Replay-safe — applying the same trigger N times produces the same end state',
    applies_to: ['webhook_ingress', 'cascade', 'settlement']
  },
  {
    id: 'compensation',
    name: 'Compensation',
    desc: 'Reversible — when a downstream step fails, prior steps emit compensating actions to undo their effects',
    applies_to: ['cascade', 'settlement']
  },
  {
    id: 'async',
    name: 'Async',
    desc: 'Queued or deferred — the trigger fires immediately but effects happen later via worker or background job',
    applies_to: ['cascade', 'notification', 'settlement', 'projection']
  }
]

const ENTITY_EXAMPLES = [
  {
    label: 'Visit tracking',
    text: 'Customers can track their cleaning visits and see when the crew is on the way.'
  },
  {
    label: 'Lead intake form',
    text: "A lead intake form that collects the customer's name, phone, square footage, and preferred service date."
  },
  {
    label: 'Recurring schedule',
    text: 'A recurring weekly cleaning plan that generates a visit every Monday at 9am until cancelled.'
  },
  {
    label: 'Audit trail',
    text: "A log of every change made to a customer's schedule — who did it, what changed, and when."
  },
  {
    label: 'Payroll record',
    text: 'A record of what each crew member earned per visit, including base rate, overtime, and bonuses, used to run payroll every two weeks.'
  },
  {
    label: 'Background command',
    text: "A 'Send Welcome Email' operation that fires when a new customer signs up. It's queued to run within 1 minute, retries up to 3 times if delivery fails, and times out after 30 seconds per attempt."
  }
]

const PATTERN_EXAMPLES = [
  {
    label: 'Booking flow',
    text: 'When a customer books a cleaning visit, the system schedules it, assigns an available crew, and sends a confirmation. The day before, a reminder goes out automatically.'
  },
  {
    label: 'Invoice chase',
    text: 'After a cleaning visit is marked complete, an invoice is generated and emailed to the customer. They have 7 days to pay before a follow-up notification is sent.'
  },
  {
    label: 'Job escalation',
    text: "When a crew member doesn't accept their assigned visit within 30 minutes of dispatch, the office manager gets notified and the visit is reassigned to another available crew."
  },
  {
    label: 'Webhook payment',
    text: 'Stripe sends us a webhook when a payment succeeds. We update the order status, mark the invoice as paid, and email the customer a receipt.'
  },
  {
    label: 'Cancellation cascade',
    text: 'When a customer cancels a visit more than 24 hours out, the slot is freed and any prepayment is refunded. Within 24 hours, a cancellation fee applies and the crew is notified the visit is off.'
  },
  {
    label: 'Contract approval',
    text: 'Sales reps draft contracts for enterprise clients. Each contract goes to our legal team for review — they can approve, reject with comments, or request changes. Once approved, the contract is sent to the client for e-signature.'
  }
]

const SYSTEM_EXAMPLES = [
  {
    label: 'Call intelligence',
    text: 'When a customer support call ends, our PBX sends a webhook with the recording. We transcribe the audio, run the transcript through an LLM to extract sentiment, action items, and a summary, then save the results against the contact. If sentiment comes back negative, the account manager gets a Slack notification with the action items.'
  },
  {
    label: 'Domain expiry watch',
    text: 'Every Monday morning, a scheduled job checks each client domain in our portfolio. For each one, the system queries the RDAP registry for expiry data. Any domain expiring within 30 days creates a renewal task assigned to the account owner and triggers an alert email. Lookup failures log an audit event for manual review.'
  },
  {
    label: 'Hiring screener',
    text: 'Applicants submit their resume through our careers page. The system runs each resume through an LLM scoring rubric against the role profile. Scores above 8 notify the hiring manager for fast-track review. Scores below 5 trigger an auto-decline email to the applicant. Mid-range scores queue as a review task for the recruiter.'
  }
]

function formatEntityCatalog() {
  const byCategory = {}
  ENTITY_CATALOG.forEach((e) => {
    if (!byCategory[e.category]) byCategory[e.category] = []
    byCategory[e.category].push(e)
  })
  let str = ''
  let lastTier = null
  Object.entries(ENTITY_CATEGORIES).forEach(([catKey, catMeta]) => {
    const entries = byCategory[catKey] || []
    if (entries.length === 0) return
    if (catMeta.tier !== lastTier) {
      str += `\n=== ${
        catMeta.tier === 'core'
          ? 'CORE (universal — every app has these)'
          : 'DOMAIN (contextual — this app does X)'
      } ===\n`
      lastTier = catMeta.tier
    }
    str += `\n${catMeta.name}:\n`
    entries.forEach((e) => {
      str += `- ${e.name}: ${e.desc}`
      if (e.example) str += ` — e.g. ${e.example}`
      str += '\n'
    })
  })
  return str
}

function formatPatternCatalog() {
  return PATTERN_CATALOG.map(
    (p) =>
      `- ${p.name} (id: ${p.id}, cell: ${p.trigger}×${p.verb}): ${p.desc} — grammar: ${
        p.grammar
      } — canonical entities: ${
        p.entities.length > 0 ? p.entities.join(', ') : '(none — variable per scenario)'
      }`
  ).join('\n')
}

function formatTriggers() {
  return Object.entries(TRIGGERS)
    .map(([k, v]) => `- ${v.name} (${k}): ${v.desc}`)
    .join('\n')
}

function formatModifiers() {
  return MODIFIERS.map(
    (m) =>
      `- ${m.name} (id: ${m.id}): ${m.desc} — typically applies to: ${m.applies_to.join(
        ', '
      )}`
  ).join('\n')
}

function formatActorArchetypes() {
  return Object.entries(ACTOR_ARCHETYPES)
    .map(([k, v]) => `- ${v.name} (${k}): ${v.description}`)
    .join('\n')
}

function extractJSON(text) {
  // Strip markdown code fences anywhere in the text (not only at edges).
  let clean = text
    .replace(/```json\s*/gi, '')
    .replace(/```/g, '')
    .trim()

  // Fast path: response is clean JSON.
  try {
    return JSON.parse(clean)
  } catch (firstErr) {
    // Slow path: walk from the first '{' tracking brace depth while
    // respecting string literals (so braces inside strings — e.g. inside
    // system_grammar's `{Pattern}` tokens — don't throw off the count).
    const start = clean.indexOf('{')
    if (start === -1) throw firstErr
    let depth = 0,
      inString = false,
      escape = false
    for (let i = start; i < clean.length; i++) {
      const c = clean[i]
      if (escape) {
        escape = false
        continue
      }
      if (inString) {
        if (c === '\\') escape = true
        else if (c === '"') inString = false
        continue
      }
      if (c === '"') {
        inString = true
        continue
      }
      if (c === '{') depth++
      else if (c === '}' && --depth === 0) {
        return JSON.parse(clean.slice(start, i + 1))
      }
    }
    throw firstErr
  }
}

async function callClaude(prompt, maxTokens = 1500) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }]
    })
  })
  if (!response.ok) throw new Error(`API ${response.status}`)
  const data = await response.json()
  const text = data.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
  return extractJSON(text)
}

async function recognizeEntity(description) {
  const prompt = `You are an entity-recognition assistant for an Information Systems framework. The user describes something they're working with in software. Match against the canonical entity catalog and return a structured recognition card.

ENTITY CATALOG:${formatEntityCatalog()}

ACTOR ARCHETYPES (canonical roles people/systems play relative to entities):
${formatActorArchetypes()}

PATTERN CATALOG (recurring sentences this entity might participate in):
${formatPatternCatalog()}

USER DESCRIPTION:
"""
${description}
"""

RECOGNITION HEURISTIC — evaluate the user's description through three questions IN ORDER before matching:

1. Could this be a **property** of a more fundamental entity? Things like "status", "square footage", "tier", "priority", "color", "size" are typically properties — they describe an attribute of something else, they don't have their own identity or lifecycle. If yes → verdict.kind = "property", match the PARENT entity (the thing this is a property of), and explain.

2. Could this be a **type or variant** of a more fundamental entity in the catalog? A "recurring visit" is a Visit variant, a "VIP customer" is a Contact variant. A named external system (Stripe, Twilio, Salesforce, QuickBooks) or any "external service / third-party / vendor system" is an Integration variant — the provider name is just flavor. A "quote", "invoice", "proposal", "contract", "NDA", "agreement", or "receipt" is a Document variant — capture the kind in variant_traits, do NOT create separate Quote, Invoice, or Contract entities (they were collapsed into Document). An email thread, chat conversation, or comment chain is a chain of Messages linked via parentMessageId — there is no separate Thread entity. A "task", "ticket", or "action item" is a Task entity (outcome-bounded work). A "cleaning visit", "appointment", or "service call" is a Visit (time-and-place bounded). A "cron job", "scheduled background process", or "queue worker" may be an Action entity if the description emphasizes the invocable/scheduled record itself (with retry, timeout, status). If it only describes the cadence and effect, it's the recurring pattern + async modifier — no Action entity needed. A "command", "operation", "job" (in the dev/queue sense), or "function call" with execution lifecycle is an Action. A Page is URL-addressable content within a Site; do not call it a Document (Document is for transactional artifacts). A tracked vehicle, equipment, or owned item is an Asset (ownership/condition concern), distinct from Resource (bookable/assignable concern). A "cancellation fee", "late payment fee", "no-show fee", "processing fee", "tax", or "discount" is NOT an entity — it is an inline line item on a Document. An "order", "purchase order", "work order", or "accepted commitment" is a Document variant (kind: order) — NOT a separate Order entity. The catalog NO LONGER contains Order; the commitment-to-fulfill lifecycle is captured on Document and tracked through Visit/Task for service work. An "audit log", "audit trail", "activity log", or "change history" is NOT a separate entity — these are Events with actor, target, and retention semantics. The catalog NO LONGER contains AuditLog; use Event with actorId set. The catalog NO LONGER contains Fee as a separate entity. Capture the fee concept in variant_traits or grammar (e.g. "Visit no-show triggers a fee line item on next invoice Document"). A "sync", "field mapping", or "connector config" is part of an Integration — do NOT create separate Sync, Mapping, or Configuration entities. When a description involves a human, distinguish: someone with system access (logs in, performs work, has a role) is a User; someone who is only a captured record (customer, lead, prospect, payer) is a Contact. The same individual can exist as both — list whichever role applies in the described scenario. A "team", "user team", "staff group", "department", "channel", or "squad" of Users is a Group. A "segment", "audience", "customer segment", "mailing list", "subscriber list", "email list", "distribution list", or "cohort" of Contacts is a Group. A "mixed group" (Users + Contacts) is also a Group. Group is distinct from Organization (a tenant boundary with billing/plan) and Tag (a flat classifier applied to individual entities). NOTE: a single "subscriber" in the sense of one registered interest in an event stream remains a Listener — Group is for the *collection*, Listener is for one registered endpoint. The defining test: same shape, same lifecycle, just different traits. If yes → verdict.kind = "variant", match the PARENT catalog entity, capture the variant-ness in variant_traits.

3. Only if neither — propose as **genuinely novel**. Must satisfy ALL: (a) distinct properties not derivable from a parent, (b) independent lifecycle, (c) appears across multiple contexts not just one. If yes → verdict.kind = "novel".

Most candidates fail at Q1 or Q2. Only rare survivors reach Q3. The variant path (Q2) is the most common — most user descriptions are variants of catalog entries.

Match against the catalog. ENTITY NOTATION — STRICT FORMAT:

The colon notation \`Entity:kind\` is reserved for catalog-defined STRUCTURAL kinds — kinds that change the entity's lifecycle, binding semantics, or framework behavior. The colon is NOT for domain flavor or business-logic-specific descriptions.

PRINCIPLE: foundational-to-information-systems → uses the colon. Business-logic-specific → does NOT. The colon is only valid when the kind appears in the entity's catalog-declared \`kinds\` array. Using a kind not in that array is hallucination.

ALLOWED uses of the colon (kinds blessed in the catalog via the entity's \`kinds\` field):
- Document — kinds: estimate, quote, invoice, order, contract, receipt, NDA. Each kind has a different lifecycle (quote → accepted/declined/expired; invoice → paid/overdue/refunded; contract → executed/terminated). Use \`Document:invoice\`, \`Document:quote\`, etc.
- Event — kinds: domain (default), audit. \`Event:audit\` denotes compliance-grade Events with append-only retention; domain Events stay as just \`Event\`.
- Contact — kinds: customer, lead, prospect. Use \`Contact:customer\` when the description specifically invokes the customer archetype (paying, transactional), \`Contact:lead\` for unqualified records, \`Contact:prospect\` for qualified-but-not-yet-customer. If the role is genuinely ambiguous, just use \`Contact\`.

For EVERY OTHER entity, use the base name ONLY. Examples of what NOT to do:
- A "cleaning visit" in a cleaning-services app → \`Visit\`, NOT \`Visit:cleaning\`. In context, all visits are cleaning — the flavor is universal, not structural.
- A "VIP customer" → \`Contact\`, NOT \`Contact:vip\`. VIP is a tier/property, not a kind that changes Contact's lifecycle.
- A "low-priority ticket" → \`Task\`, NOT \`Task:low-priority\`. Priority is a property value.
- A "follow-up notification" or "invoice email" → \`Notification\`, NOT \`Notification:follow-up\` or \`Notification:invoice-email\`. The purpose/channel belongs in grammar text or variant_traits.
- A "Stripe webhook" → \`Webhook\` (and \`Integration\` separately for Stripe). The Stripe-ness belongs as Integration context, not on Webhook.
- A "morning appointment" → \`Visit\`, NOT \`Visit:morning\`. Time-of-day is a property of the instance.

WHERE domain flavor SHOULD go:
- In ENTITY recognition: in \`variant_traits\` (what distinguishes THIS user's instance from textbook).
- In PATTERN recognition: bake domain words into the filled-in \`grammar\` text where they read naturally — e.g. \`[Customer] books a cleaning [Visit] for a scheduled date → ...\`
- Actor labels (Customer, Crew, Admin, Tech, Manager, Lead, Subscriber) ALWAYS live in \`actors_involved\` with their archetype — NEVER in entity names. BUT: the underlying catalog entity (User or Contact) backing that actor MUST also appear in \`entities_involved\` when the person participates in the data flow (gets emailed, has state changed, performs an action). Contact for record-only people (customers, leads, prospects, payers without system access). User for people with authenticated access (logged-in staff, admins, crew with portal logins). Example: a webhook delivers a receipt email to a customer → entities_involved includes Contact AND actors_involved includes { archetype: "subject", label: "Customer" }. The two layers are coordinated.

DEPRECATED entity names — these were collapsed; resolve to canonical bases:
- Invoice, Quote, Contract, Order → \`Document:<kind>\`
- Thread → chain of Messages (use \`Message\`; note threading in variant_traits)
- Sync, Mapping, Configuration → fold into \`Integration\`
- AuditLog → \`Event:audit\`
- Job (work-unit sense) → \`Task\`
- Subscription (event-routing sense) → \`Listener\`
- Fee → inline line item on Document (NOT in entities_involved)

NEVER use compound names like \`CleaningVisit\`, \`WorkOrder\`, or \`InvoiceDocument\`. Always either \`Base\` or \`Base:kind\` (where kind is catalog-defined per the rules above).

The base before any colon MUST be a name in the active catalog. If the base isn't in the catalog, you have either (a) hallucinated an entity, or (b) found something genuinely novel worth flagging.

GRAMMAR FIELD — STRICT FORMAT (applies to the \`grammar\` string in pattern/system mode):
- Brackets \`[X]\` denote canonical catalog ENTITIES only. Always a valid catalog entity name (with colon-kind notation if structural per the rules above).
- Actor labels (Customer, Crew, Admin, Manager, Tech, Lead, Subscriber) NEVER go in brackets. Refer to them as plain text in the surrounding grammar — e.g. \`delivers [Notification] to the Customer\`, NOT \`delivers [Notification] to [Customer]\`.
- Domain flavor on notifications, visits, messages, events, etc. (e.g. "follow-up notification", "invoice email", "cleaning visit", "reminder notification") goes in plain text adjacent to the bracket — e.g. \`sends a follow-up [Notification] to the Customer\` or \`sends the invoice [Notification] to the Customer\`, NOT \`[Notification:follow-up]\` or \`[Notification:invoice-email]\`.
- Only the catalog-defined structural kinds may use colon-notation inside brackets: \`[Document:invoice]\`, \`[Document:quote]\`, \`[Document:order]\`, \`[Document:contract]\`, \`[Document:receipt]\`, \`[Document:NDA]\`, \`[Event:audit]\`. Every other entity appears as bare \`[Entity]\`.
- The grammar string should READ as a sentence in the user's domain. Domain words are inline prose; bracketed tokens are the framework grounding.
- Example for a service business: \`[Visit] transitions to complete → creates [Document:invoice] → sends the invoice [Notification] to the Customer; if [Payment] not created within 7 days of [Document:invoice] dueAt, sends a follow-up [Notification] to the Customer\`.


VERB VOCABULARY — STRICT for the grammar field. When an entity appears as the direct object of an action, the verb MUST come from this controlled list:

BOUNDARY verbs (data crosses the system edge):
- \`submit\` — external party volunteers data IN (forms, signups, user uploads)
- \`receive\` — external system pushes data IN (webhooks, inbound API)
- \`send\` — system delivers data OUT (notifications, messages, outbound API calls)
- \`publish\` — system makes data externally readable (Page goes live, report becomes available)

INTERNAL verbs (within the system):
- \`create\` — a new entity instance is written. Use for "this thing comes into existence": creates [Visit], creates [Payment], creates [Event].
- \`transitions to\` — an existing entity's state field changes. Use for status moves: transitions to complete, to cancelled, to refunded, to accepted, to assigned. Reference the entity's canonical transitions where they exist.
- \`update\` — non-state fields on an existing entity change.
- \`read\` — query or derive data. Often implicit; make explicit when reading drives a decision (reads matching [Listener] to resolve recipients).

REWRITES — replace these domain words with the canonical verb:
- captures [Payment] → creates [Payment]
- generates [Document:invoice] → creates [Document:invoice]
- delivers [Notification] / notifies the Customer → sends [Notification] (to the Customer)
- marks [Visit] complete → transitions [Visit] to complete
- refunds [Payment] → transitions [Payment] to refunded
- cancels [Schedule] (as a system action) → transitions [Schedule] to cancelled
- accepts [Document:quote] → transitions [Document:quote] to accepted
- queries / aggregates [Entities] → reads [Entities]
- composes [Message] → creates [Message]
- emits [Event] → creates [Event]

TRIGGER LINES (the plain-text narration of what fired the activation, e.g. "Customer cancels", "24 hours before each Visit") are NOT bound by this vocabulary — they describe the activating event in everyday language. Only the BODY of each \`→\` clause uses the controlled verbs.

Return ONLY JSON (no fences):
{
  "verdict": {
    "kind": "property|variant|novel",
    "parent": "EntityName the input is a property/variant of, or null if novel",
    "reasoning": "1-2 sentences naming which question fired and why"
  },
  "match": { "name": "ExactCatalogEntryName or null", "confidence": 1-5, "why": "1-2 sentences" },
  "variant_traits": ["1-3 specific traits of THIS user's instance that distinguish it from the textbook"],
  "touches_verbs": ["secondary verbs this user's instance touches beyond home — 1-4 entries from the verb list, just the IDs"],
  "actor_roles": [{ "archetype": "subject|performer|coordinator|author|owner|observer|system", "label": "the specific name from the user's domain, e.g. Customer for subject, Crew for performer" }],
  "constraints": ["1-4 typical guards/rules that apply to this entity in the user's context"],
  "typical_patterns": ["1-3 pattern IDs from the catalog this entity typically participates in"],
  "typical_neighbors": ["catalog entity names typically paired"],
  "detected_transitions": [{ "from": "current state", "to": "next state", "trigger": "what causes the change in user's description", "in_canonical_set": true|false, "is_inferred": true|false }],
  "alternatives": [{ "name": "AltName", "why_considered": "...", "why_rejected": "..." }],
  "is_genuine_miss": false,
  "suggested_new_entity": null
}

TRANSITIONS — if the matched entity has a "transitions" field in the catalog, those are its canonical lifecycle moves. Detect any transitions present in the user's description:
- If the user describes a state change matching a canonical transition (or close variant), include it with in_canonical_set=true.
- If the user describes a state change NOT in the canonical set, include it with in_canonical_set=false — it may be a variant transition worth noting.
- If the user doesn't describe transitions but the entity has canonical ones, leave detected_transitions empty (don't fabricate them; this is detection, not enumeration).
- For entities WITHOUT transitions in the catalog: if the user describes a state change, include it with in_canonical_set=false and is_inferred=true.

When verdict.kind is "property" or "variant", match.name MUST be the parent entity (typically same as verdict.parent if it's in the catalog). When verdict.kind is "novel" AND confidence ≤ 2, set is_genuine_miss true and fill suggested_new_entity: { "name": "PascalCaseName", "tier_guess": "core|domain", "category_guess": "identity_access|capture|communication|integration|read_surfaces|operations|meta|service_scheduling|commerce_value|content_public", "definition": "1 sentence" }`

  return await callClaude(prompt)
}

async function recognizePattern(description, sessionEntities) {
  const entityContext =
    sessionEntities.length > 0
      ? `\nUSER'S ALREADY-RECOGNIZED ENTITIES (use these names when possible):\n${sessionEntities
          .map((e) => `- ${e.canonicalName}`)
          .join('\n')}\n`
      : ''
  const prompt = `You are a pattern-recognition assistant for an Information Systems framework. The user describes an interaction, event, or recurring behavior. Match against the canonical pattern catalog.

The pattern catalog is organized as a 2-axis grid:
- **Trigger axis** (what initiates the pattern): user, time, state, external
- **Verb axis** (what the pattern primarily does, in information-flow terms): capture, communicate, transform, surface, other (operational/value/authority concerns that don't fit the four info-flow verbs)

Every pattern lives at one cell. e.g. Submission = (user × capture), Cascade = (state × coordinate), Webhook ingress = (external × transform).

TRIGGER AXIS:
${formatTriggers()}

PATTERN CATALOG (cell is shown as trigger×verb):
${PATTERN_CATALOG.map(
  (p) =>
    `- ${p.name} (id: ${p.id}, cell: ${p.trigger}×${p.verb})\n  Description: ${
      p.desc
    }\n  Grammar: ${p.grammar}\n  Typical entities: ${
      p.entities.join(', ') || '(varies)'
    }\n  Typical actors: ${p.actors.join(', ')}`
).join('\n\n')}

MODIFIERS (overlays onto a base pattern — NOT separate patterns):
${formatModifiers()}

ACTOR ARCHETYPES:
${formatActorArchetypes()}
${entityContext}
USER DESCRIPTION:
"""
${description}
"""

PATTERN RECOGNITION — two-step:
1. **Identify the trigger**: read the user's description and decide which of the four initiating forces fires this pattern. Most descriptions have one clear trigger; if ambiguous, pick the *root* cause (e.g. "when a visit is marked complete, an invoice is generated" — the root trigger is state, not user, even though a user marked it).
2. **Identify the dominant verb**: what does the pattern primarily *do*? Look past side effects to the main action. A notification is sent → communicate. Money moves → transact. Data is reshaped → transform.

The (trigger × verb) cell narrows you to one — or at most two — pattern candidates. Confirm by grammar match.

MODIFIERS — separate from the base pattern. If the scenario adds idempotency, async delivery, fan-out via listeners, compensation/reversal, or is a cancellation (reverse-cascade), list those modifier ids in detected_modifiers. They do NOT change the match — they qualify it.

ENTITY-RESOLUTION RULES for entities_involved — strict:
- Use canonical catalog entity names ONLY. Resolve variants to their parent (Confirmation Notification → Notification, Recurring Visit → Visit).
- If multiple variants of the same parent appear (e.g. a confirmation AND a reminder), list the parent ONCE. Capture variant flavors in the grammar string or variant_traits, not as duplicate entries.
- Actor labels (Customer, Crew, Admin, Manager, Tech, Cleaner) NEVER belong here — they live in actors_involved with their archetype. User (people with system access — crew with logins, admins, dispatchers) and Contact (descriptive records — customers, leads, prospects without access) are the catalog entities; the role label is the actor archetype.
- Named external systems / third-party services / APIs (Stripe, Twilio, Salesforce, QuickBooks, plus generic "external service / third-party / vendor system") resolve to Integration. The named provider is variant flavor (Stripe Integration), not its own entity. The inbound message itself is Webhook (separate entity). A Stripe payment webhook = Integration + Webhook, both listed.
- Domain-specific flavor (Cleaning Visit, Welcome Email, Day-Before Reminder) belongs in the grammar string, not in entities_involved.
- The catalog has ONE Document entity covering quotes, invoices, contracts, receipts, and NDAs. Resolve ALL of these to Document — distinguish the kind in grammar text (e.g. [Document:invoice]) or variant_traits, never as separate entities. The catalog NO LONGER contains Quote, Invoice, or Contract as standalone entities.
- Threads / email conversations / chat threads are chains of Messages linked via parentMessageId, NOT a separate Thread entity. The catalog NO LONGER contains Thread.
- A scheduled background process (cron job, queue worker, nightly sync, Sidekiq/Celery/Bull job) is NOT a Task entity. It MAY produce or BE an Action (an invokable operation with retry/lifecycle), and it acts on Events. Reserve Task for outcome-bounded work assigned to a human performer (tickets, action items).
- A web page, landing page, blog post, or any URL-addressable content is a Page entity, contained by a Site. A 'client website' or 'marketing site' is a Site. Do NOT collapse Pages into Documents (Document is for transactional artifacts like quotes/invoices/contracts).
- Imposed monetary charges (cancellation fee, late fee, no-show fee, processing fee, tax, discount) are NOT separate entities — they are inline line items on a Document.
- An order, purchase order, or work order is a Document variant (kind: order), NOT a separate Order entity. The catalog NO LONGER contains Order. Use [Document:order] in grammar; the fulfillment side is tracked through Visit/Task, not through Order state.
- Audit logs, activity trails, change histories, and compliance records are NOT separate entities — they are Events with actor references and retention policy. The catalog NO LONGER contains AuditLog. When a description references an audit trail, capture it as Event in entities_involved and note the audit flavor in variant_traits or grammar (e.g. [Event:audit]). The catalog NO LONGER contains a Fee entity. When the user describes such a charge, capture it in grammar text or variant_traits, NOT as an entity in entities_involved.
- A tracked physical or digital asset (vehicle, equipment, inventory item, file) is an Asset entity. Distinguish from Resource: if the description emphasizes 'we own this and track its condition/value', it's Asset; if the description emphasizes 'this gets booked/assigned with capacity', it's Resource. A truck can be both.
- Action vs Event: Action is an invokable/scheduled/executing operation with intent (a command — "Send Reminder", "Refund Payment", "Sync Customer"). Event is what has happened (a record of an occurrence — "PaymentSucceeded", "VisitMarkedComplete", "DocumentSent"). When the user describes the system DOING something with retry/timeout/scheduling semantics, it's an Action. When they describe something that HAPPENED for downstream reaction, it's an Event. Most flows involve both (Action runs → produces Event → triggers downstream). Visit is time-and-place bounded interactions. The catalog renamed Job → Task to make this distinction unambiguous.
- Sync jobs, field mappings, and connector configuration are parts of an Integration entity, NOT separate Sync, Mapping, or Configuration entities. The catalog NO LONGER contains Sync, Mapping, or Configuration.
- Prefer the user's already-recognized entities from session context when applicable.

COMPLETENESS CHECK — after building your initial entities_involved list, run two passes:
1. **Catalog-anchor pass:** if match.id corresponds to a catalog pattern, every entity in that pattern's canonical entities list MUST appear in entities_involved unless genuinely absent from the user's scenario. If you include the pattern but drop a canonical entity, explain in variant_traits why. Most often the canonical entities ARE present and just got overlooked.
2. **Noun-sweep pass:** re-scan the user's description for nouns. Every noun phrase that matches an active catalog entity name (Document, Payment, Visit, Task, Schedule, Webhook, Event, Notification, Integration, Contact, User, Action, Page, Site, Asset, Group, etc.) MUST appear in entities_involved. Do not silently skip catalog hits. CRITICAL: when the user writes "order", "invoice", "quote", "contract", "receipt", "NDA" — these are NOT entity names. They are kinds of Document. Emit as \`Document:order\`, \`Document:invoice\`, \`Document:quote\`, \`Document:contract\`, \`Document:receipt\`, \`Document:NDA\` — never as bare "Order" or "Invoice". Similarly "task" → Task (not "Job"), "audit log" → Event with audit flavor (not "AuditLog"), "customer"/"crew"/"admin" → Contact or User (per the grounding rule). A "team", "segment", "mailing list", "subscriber list", "audience", or "department" referenced as a *collective recipient or scope* is a Group — emit Group in entities_involved and put the descriptive name as plain text adjacent (e.g. \`sends [Notification] to the Sales team [Group]\`).

ENTITY NOTATION — STRICT FORMAT:

The colon notation \`Entity:kind\` is reserved for catalog-defined STRUCTURAL kinds — kinds that change the entity's lifecycle, binding semantics, or framework behavior. The colon is NOT for domain flavor or business-logic-specific descriptions.

PRINCIPLE: foundational-to-information-systems → uses the colon. Business-logic-specific → does NOT. The colon is only valid when the kind appears in the entity's catalog-declared \`kinds\` array. Using a kind not in that array is hallucination.

ALLOWED uses of the colon (kinds blessed in the catalog via the entity's \`kinds\` field):
- Document — kinds: estimate, quote, invoice, order, contract, receipt, NDA. Each kind has a different lifecycle (quote → accepted/declined/expired; invoice → paid/overdue/refunded; contract → executed/terminated). Use \`Document:invoice\`, \`Document:quote\`, etc.
- Event — kinds: domain (default), audit. \`Event:audit\` denotes compliance-grade Events with append-only retention; domain Events stay as just \`Event\`.
- Contact — kinds: customer, lead, prospect. Use \`Contact:customer\` when the description specifically invokes the customer archetype (paying, transactional), \`Contact:lead\` for unqualified records, \`Contact:prospect\` for qualified-but-not-yet-customer. If the role is genuinely ambiguous, just use \`Contact\`.

For EVERY OTHER entity, use the base name ONLY. Examples of what NOT to do:
- A "cleaning visit" in a cleaning-services app → \`Visit\`, NOT \`Visit:cleaning\`. In context, all visits are cleaning — the flavor is universal, not structural.
- A "VIP customer" → \`Contact\`, NOT \`Contact:vip\`. VIP is a tier/property, not a kind that changes Contact's lifecycle.
- A "low-priority ticket" → \`Task\`, NOT \`Task:low-priority\`. Priority is a property value.
- A "follow-up notification" or "invoice email" → \`Notification\`, NOT \`Notification:follow-up\` or \`Notification:invoice-email\`. The purpose/channel belongs in grammar text or variant_traits.
- A "Stripe webhook" → \`Webhook\` (and \`Integration\` separately for Stripe). The Stripe-ness belongs as Integration context, not on Webhook.
- A "morning appointment" → \`Visit\`, NOT \`Visit:morning\`. Time-of-day is a property of the instance.

WHERE domain flavor SHOULD go:
- In ENTITY recognition: in \`variant_traits\` (what distinguishes THIS user's instance from textbook).
- In PATTERN recognition: bake domain words into the filled-in \`grammar\` text where they read naturally — e.g. \`[Customer] books a cleaning [Visit] for a scheduled date → ...\`
- Actor labels (Customer, Crew, Admin, Tech, Manager, Lead, Subscriber) ALWAYS live in \`actors_involved\` with their archetype — NEVER in entity names. BUT: the underlying catalog entity (User or Contact) backing that actor MUST also appear in \`entities_involved\` when the person participates in the data flow (gets emailed, has state changed, performs an action). Contact for record-only people (customers, leads, prospects, payers without system access). User for people with authenticated access (logged-in staff, admins, crew with portal logins). Example: a webhook delivers a receipt email to a customer → entities_involved includes Contact AND actors_involved includes { archetype: "subject", label: "Customer" }. The two layers are coordinated.

DEPRECATED entity names — these were collapsed; resolve to canonical bases:
- Invoice, Quote, Contract, Order → \`Document:<kind>\`
- Thread → chain of Messages (use \`Message\`; note threading in variant_traits)
- Sync, Mapping, Configuration → fold into \`Integration\`
- AuditLog → \`Event:audit\`
- Job (work-unit sense) → \`Task\`
- Subscription (event-routing sense) → \`Listener\`
- Fee → inline line item on Document (NOT in entities_involved)

NEVER use compound names like \`CleaningVisit\`, \`WorkOrder\`, or \`InvoiceDocument\`. Always either \`Base\` or \`Base:kind\` (where kind is catalog-defined per the rules above).

The base before any colon MUST be a name in the active catalog. If the base isn't in the catalog, you have either (a) hallucinated an entity, or (b) found something genuinely novel worth flagging.

GRAMMAR FIELD — STRICT FORMAT (applies to the \`grammar\` string in pattern/system mode):
- Brackets \`[X]\` denote canonical catalog ENTITIES only. Always a valid catalog entity name (with colon-kind notation if structural per the rules above).
- Actor labels (Customer, Crew, Admin, Manager, Tech, Lead, Subscriber) NEVER go in brackets. Refer to them as plain text in the surrounding grammar — e.g. \`delivers [Notification] to the Customer\`, NOT \`delivers [Notification] to [Customer]\`.
- Domain flavor on notifications, visits, messages, events, etc. (e.g. "follow-up notification", "invoice email", "cleaning visit", "reminder notification") goes in plain text adjacent to the bracket — e.g. \`sends a follow-up [Notification] to the Customer\` or \`sends the invoice [Notification] to the Customer\`, NOT \`[Notification:follow-up]\` or \`[Notification:invoice-email]\`.
- Only the catalog-defined structural kinds may use colon-notation inside brackets: \`[Document:invoice]\`, \`[Document:quote]\`, \`[Document:order]\`, \`[Document:contract]\`, \`[Document:receipt]\`, \`[Document:NDA]\`, \`[Event:audit]\`. Every other entity appears as bare \`[Entity]\`.
- The grammar string should READ as a sentence in the user's domain. Domain words are inline prose; bracketed tokens are the framework grounding.
- Example for a service business: \`[Visit] transitions to complete → creates [Document:invoice] → sends the invoice [Notification] to the Customer; if [Payment] not created within 7 days of [Document:invoice] dueAt, sends a follow-up [Notification] to the Customer\`.


VERB VOCABULARY — STRICT for the grammar field. When an entity appears as the direct object of an action, the verb MUST come from this controlled list:

BOUNDARY verbs (data crosses the system edge):
- \`submit\` — external party volunteers data IN (forms, signups, user uploads)
- \`receive\` — external system pushes data IN (webhooks, inbound API)
- \`send\` — system delivers data OUT (notifications, messages, outbound API calls)
- \`publish\` — system makes data externally readable (Page goes live, report becomes available)

INTERNAL verbs (within the system):
- \`create\` — a new entity instance is written. Use for "this thing comes into existence": creates [Visit], creates [Payment], creates [Event].
- \`transitions to\` — an existing entity's state field changes. Use for status moves: transitions to complete, to cancelled, to refunded, to accepted, to assigned. Reference the entity's canonical transitions where they exist.
- \`update\` — non-state fields on an existing entity change.
- \`read\` — query or derive data. Often implicit; make explicit when reading drives a decision (reads matching [Listener] to resolve recipients).

REWRITES — replace these domain words with the canonical verb:
- captures [Payment] → creates [Payment]
- generates [Document:invoice] → creates [Document:invoice]
- delivers [Notification] / notifies the Customer → sends [Notification] (to the Customer)
- marks [Visit] complete → transitions [Visit] to complete
- refunds [Payment] → transitions [Payment] to refunded
- cancels [Schedule] (as a system action) → transitions [Schedule] to cancelled
- accepts [Document:quote] → transitions [Document:quote] to accepted
- queries / aggregates [Entities] → reads [Entities]
- composes [Message] → creates [Message]
- emits [Event] → creates [Event]

TRIGGER LINES (the plain-text narration of what fired the activation, e.g. "Customer cancels", "24 hours before each Visit") are NOT bound by this vocabulary — they describe the activating event in everyday language. Only the BODY of each \`→\` clause uses the controlled verbs.

Return ONLY JSON:
{
  "match": { "id": "pattern_id or null", "name": "PatternName", "trigger": "user|time|state|external", "verb": "capture|communicate|transform|surface|other", "confidence": 1-5, "why": "1-2 sentences" },
  "grammar": "Filled-in grammar specific to the user's context, e.g. '[Customer] books [Crew time] → creates [Visit]'",
  "entities_involved": ["entity names — prefer the user's already-recognized ones, otherwise catalog entries"],
  "actors_involved": [{ "archetype": "subject|performer|...", "label": "specific role name in user's context" }],
  "variant_traits": ["1-3 traits of THIS instance that distinguish from the textbook pattern"],
  "common_variations": ["2-3 variations of this pattern relevant to the user's case"],
  "detected_modifiers": [{ "id": "listener|cancellation|idempotency|compensation|async", "why": "1 sentence justifying the modifier's applicability" }],
  "key_transitions": [{ "entity": "EntityName", "from": "state", "to": "state", "trigger": "what causes it", "role": "entry|effect|both", "in_canonical_set": true|false }],
  "alternatives": [{ "name": "AltPattern", "why_considered": "...", "why_rejected": "..." }],
  "is_genuine_miss": false,
  "suggested_new_pattern": null
}

KEY TRANSITIONS — patterns are often anchored by entity state changes. Identify them:
- The **entry trigger** is the transition (or external event) that initiates the pattern. role = "entry". e.g. for a payment cycle triggered by a completed visit, the Visit's in_progress → complete transition has role="entry".
- **Effects** are transitions caused by the pattern as it unfolds. role = "effect". e.g. Document draft → sent, Visit scheduled → confirmed, Payment processing → succeeded.
- A transition can be both if it both triggers downstream effects AND is itself an effect of an upstream transition. role = "both".
- For each transition, check the entity's "transitions" field in the catalog. If present, in_canonical_set=true. If the transition described isn't in the catalog (or the entity has no catalog transitions), in_canonical_set=false.
- Only include transitions that are explicitly or strongly implicitly present in the user's description. Don't list every transition the involved entities are *capable of* — only the ones this scenario actually involves.

If confidence ≤ 2: is_genuine_miss true, suggested_new_pattern: { "name": "PascalName", "grammar": "...", "description": "1 sentence" }`

  return await callClaude(prompt)
}

async function recognizeSystem(description, sessionEntities) {
  const entityContext =
    sessionEntities.length > 0
      ? `\nUSER'S ALREADY-RECOGNIZED ENTITIES (prefer these names when possible):\n${sessionEntities
          .map((e) => `- ${e.canonicalName}`)
          .join('\n')}\n`
      : ''

  const prompt = `You are a system-reading assistant for an Information Systems framework.
The user describes a FEATURE, SYSTEM, WORKFLOW, or CAPABILITY. Your job is to read it as a GRAMMAR OF OPERATIONS over a catalog of entities — what data comes in, what gets created or changed, what goes out, and what crosses the system boundary.

You do NOT classify the system into named patterns. You describe its operations directly, grounded in the entity catalog and a controlled verb vocabulary.

ENTITY CATALOG:
${formatEntityCatalog()}

TRIGGER AXIS (how an operation thread is activated):
${formatTriggers()}

ACTOR ARCHETYPES:
${formatActorArchetypes()}
${entityContext}
USER DESCRIPTION:
"""
${description}
"""

ENTITY DISCIPLINE — build \`entities_involved\` (every catalog entity the system touches) with a noun-sweep:

Re-scan the description for nouns. Every noun phrase that matches an active catalog entity name MUST appear in entities_involved. Key resolutions:
- "blog post", "article", "landing page", "service page", "docs page", "product page", "marketing page" -> \`Page\` (URL-addressable content within a Site). NEVER invent \`Post\`, \`Article\`, or \`BlogPost\`.
- "marketing site", "client website", "documentation portal" -> \`Site\`.
- "order", "invoice", "quote", "contract", "receipt", "NDA" -> \`Document:<kind>\`.
- "audit log", "activity trail", "change history" -> \`Event\` (audit flavor in grammar text).
- "team", "segment", "mailing list", "subscriber list", "audience", "department" -> \`Group\`.
- "task", "ticket", "action item" -> \`Task\`.
- "cleaning visit", "appointment", "service call" -> \`Visit\`.
- "workflow", "pipeline", "stages", "approval chain", "onboarding flow" -> \`Flow\`.
- "customer", "lead", "prospect", "subscriber" (individual) -> actor labels backed by the \`Contact\` entity.
- "staff", "crew", "admin", "rep", "dispatcher" -> actor labels backed by the \`User\` entity.

If after the sweep a noun still has no catalog home, only THEN consider whether it's genuinely novel. Most user-domain nouns resolve to catalog entries via variant collapse — don't bypass the catalog.

ENTITY NOTATION — STRICT FORMAT:

The colon notation \`Entity:kind\` is reserved for catalog-defined STRUCTURAL kinds — kinds that change the entity's lifecycle or framework behavior. NOT for domain flavor.

ALLOWED uses of the colon (kinds blessed in the catalog):
- Document — kinds: estimate, quote, invoice, order, contract, receipt, NDA.
- Event — kinds: domain (default), audit. \`Event:audit\` for compliance-grade append-only Events.
- Contact — kinds: customer, lead, prospect.

For EVERY OTHER entity, use the base name ONLY. Examples of what NOT to do:
- A "cleaning visit" -> \`Visit\`, NOT \`Visit:cleaning\`.
- A "VIP customer" -> \`Contact\`, NOT \`Contact:vip\`.
- A "follow-up notification" -> \`Notification\`, NOT \`Notification:follow-up\` (flavor goes in grammar prose).
- A "Stripe webhook" -> \`Webhook\` (and \`Integration\` separately for Stripe).

Actor labels (Customer, Crew, Admin, Tech, Manager, Lead, Subscriber) ALWAYS live in \`actors_involved\` with their archetype — NEVER in entity names. BUT the underlying catalog entity (User or Contact) backing that actor MUST also appear in \`entities_involved\` when the person participates in the data flow. Contact for record-only people (customers, leads, payers without system access). User for people with authenticated access.

DEPRECATED entity names — resolve to canonical bases:
- Invoice, Quote, Contract, Order -> \`Document:<kind>\`
- Thread -> chain of Messages (use \`Message\`)
- Sync, Mapping, Configuration -> fold into \`Integration\`
- AuditLog -> \`Event:audit\`
- Job (work-unit sense) -> \`Task\`
- Subscription (event-routing sense) -> \`Listener\`

The base before any colon MUST be a name in the active catalog.

VERB VOCABULARY — STRICT. Every operation in the grammar uses exactly one of these 11 verbs. The verb encodes a SIGNATURE: does data cross the system boundary, and does our stored state change. Choose precisely — the verb is the main signal a reader gets.

INTERNAL (no boundary crossing):
- \`read\` — observe our own stored state without changing it (query/derive; make explicit when reading drives a decision, e.g. "reads matching [Listener]").
- \`create\` — write a NEW entity instance ("creates [Visit]", "creates [Payment]", "creates [Event]").
- \`update\` — change non-state fields on an existing entity.
- \`transitions to\` — change an existing entity's STATE field ("transitions [Visit] to complete", "transitions [Payment] to refunded").

INBOUND (external data enters):
- \`submit\` — an external ACTOR volunteers data in (forms, signups, uploads). Actor is usually the grammatical subject: "Customer submits [Form]".
- \`receive\` — an external SYSTEM pushes data in and we store it (webhooks, inbound API): "[Integration] receives [Webhook]".
- \`fetch\` — we PULL external data and use it transiently WITHOUT persisting it as-is (poll an external read-only source, look something up): "fetches RDAP record", "fetches current price".

OUTBOUND (our data leaves):
- \`send\` — transmit data OUT to any recipient, human OR system. Covers notifications/emails to people AND writes to external systems (we don't track whether the far side stores it). "sends [Notification] to the Customer", "sends [Document:invoice] to QuickBooks".
- \`publish\` — make internal data externally available + flip its state (a [Page] goes live, a report becomes public).

EXCHANGE (data both enters and leaves in one operation):
- \`sync\` — two-way data convergence with an external system (bidirectional integration): "[Integration] syncs [Visit] records with TCS".
- \`consult\` — a round-trip query: send a payload out, get a computed answer back, persist nothing. This is the LLM-call / geocode / external-scoring primitive: "consults the LLM for a score", "consults the geocoder".

REWRITES — replace these domain words with the canonical verb:
- captures [Payment] / generates [Document:invoice] -> create
- delivers [Notification] / notifies the Customer -> send [Notification] (to the Customer)
- writes to QuickBooks / posts to Stripe / pushes to an external system -> send (... to QuickBooks)
- calls the LLM / asks Claude / scores via AI / runs through a model -> consult
- polls / pulls a read-only external source / looks up -> fetch
- two-way sync / reconciles with / keeps in sync with external -> sync
- marks [Visit] complete -> transitions [Visit] to complete
- refunds [Payment] -> transitions [Payment] to refunded
- cancels [Schedule] (system action) -> transitions [Schedule] to cancelled
- queries / aggregates [Entities] -> reads [Entities]
- emits [Event] -> creates [Event]

FLOWS FORMAT — segment the system into FLOWS. A flow is ONE trigger and the chain of operations that fire from it. Each distinct activation of the system is its own flow. Most systems have 2-5 flows.

Each flow has:
- \`trigger\`: the trigger type — user | time | state | external.
- \`label\`: the activating event in plain everyday language (e.g. "Author publishes a blog post", "Monthly newsletter cadence fires", "Prospect submits a quote request"). NOT bound to the verb vocabulary — this is narration.
- \`grammar\`: the operation chain that fires from this trigger, as a \`->\` sequence (render arrows as the arrow character). Each \`->\` clause body uses exactly ONE controlled verb. Brackets \`[X]\` for catalog entities only; actor labels are plain prose; domain flavor is inline prose adjacent to the bracket, never inside it.
- \`entities\`: the catalog entities THIS flow touches.

Rules:
- One flow per distinct trigger/activation. Don't merge two different triggers into one flow; don't split one activation into several flows.
- The flow's grammar describes only what happens within that activation.
- An entity can appear in multiple flows — that's the connective tissue of the system (it'll surface as a shared entity).

Example — a recurring subscription cleaning business with cancellation produces four flows:
1. trigger "user", label "Customer submits a booking", grammar "creates [Visit] and [Schedule] for the Customer → [Schedule] creates future [Visit] instances on cadence", entities [Visit, Schedule, Contact]
2. trigger "state", label "A Visit is completed", grammar "creates [Document:invoice] → creates [Payment] → sends the receipt [Notification] to the Customer", entities [Visit, Document, Payment, Notification, Contact]
3. trigger "time", label "An invoice goes unpaid past its due date", grammar "sends a follow-up [Notification] to the Customer", entities [Document, Notification, Contact]
4. trigger "user", label "Customer cancels", grammar "transitions [Schedule] to cancelled → transitions pending [Visit] to cancelled → transitions prepaid [Payment] to refunded → sends [Notification] to the Customer", entities [Schedule, Visit, Payment, Notification, Contact]

Return ONLY JSON (no fences):
{
  "summary": "1-2 sentence read of what kind of system this is",
  "flows": [
    {
      "trigger": "user|time|state|external",
      "label": "plain-language activating event",
      "grammar": "operation chain using controlled verbs and [Entities]",
      "entities": ["catalog entities this flow touches"]
    }
  ],
  "actors_involved": [{ "archetype": "subject|performer|coordinator|author|owner|observer|system", "label": "specific role name" }],
  "is_genuine_miss": false
}

If the description doesn't describe a recognizable system (too vague, or no catalog entities apply), set is_genuine_miss: true with an empty flows array.`

  return await callClaude(prompt, 4000)
}

export default function EntitiesAndPatterns() {
  const [view, setView] = useState('recognizer')
  const [mode, setMode] = useState('system')
  const [description, setDescription] = useState('')
  const [isRecognizing, setIsRecognizing] = useState(false)
  const [currentRecognition, setCurrentRecognition] = useState(null)
  const [sessionEntities, setSessionEntities] = useState([])
  const [sessionPatterns, setSessionPatterns] = useState([])
  const [variantNote, setVariantNote] = useState('')
  const [error, setError] = useState(null)
  const [expandedCategories, setExpandedCategories] = useState({})
  const [selectedCatalogEntity, setSelectedCatalogEntity] = useState(null)
  const [selectedCatalogPattern, setSelectedCatalogPattern] = useState(null)
  const [sidebarTab, setSidebarTab] = useState('session')
  const [copied, setCopied] = useState(false)
  const [auditCopied, setAuditCopied] = useState(false)
  const [planningNotesCopied, setPlanningNotesCopied] = useState(false)
  const [catalogSearch, setCatalogSearch] = useState('')

  const handleRecognize = async () => {
    if (!description.trim() || isRecognizing) return
    setIsRecognizing(true)
    setError(null)
    setCurrentRecognition(null)
    setVariantNote('')
    try {
      let result
      if (mode === 'entity') result = await recognizeEntity(description.trim())
      else if (mode === 'system')
        result = await recognizeSystem(description.trim(), sessionEntities)
      else result = await recognizePattern(description.trim(), sessionEntities)
      setCurrentRecognition(result)
    } catch (e) {
      setError(e.message || 'Recognition failed')
    } finally {
      setIsRecognizing(false)
    }
  }

  const handleAcceptEntity = () => {
    if (!currentRecognition?.match?.name) return
    const entry = {
      id: crypto.randomUUID(),
      canonicalName: currentRecognition.match.name,
      category:
        ENTITY_CATALOG.find((e) => e.name === currentRecognition.match.name)?.category ||
        null,
      touchesVerbs: currentRecognition.touches_verbs || [],
      actorRoles: currentRecognition.actor_roles || [],
      constraints: currentRecognition.constraints || [],
      typicalPatterns: currentRecognition.typical_patterns || [],
      variantNotes: [
        ...(currentRecognition.variant_traits || []),
        ...(variantNote.trim() ? [variantNote.trim()] : [])
      ],
      originalDescription: description.trim(),
      isNovel: false,
      recognizedAt: new Date().toISOString()
    }
    setSessionEntities((prev) => [...prev, entry])
    setDescription('')
    setCurrentRecognition(null)
    setVariantNote('')
  }

  const handleAcceptPattern = () => {
    if (!currentRecognition?.match?.name) return
    const entry = {
      id: crypto.randomUUID(),
      canonicalName: currentRecognition.match.name,
      patternId: currentRecognition.match.id,
      grammar: currentRecognition.grammar,
      entitiesInvolved: currentRecognition.entities_involved || [],
      actorsInvolved: currentRecognition.actors_involved || [],
      variantNotes: [
        ...(currentRecognition.variant_traits || []),
        ...(variantNote.trim() ? [variantNote.trim()] : [])
      ],
      originalDescription: description.trim(),
      isNovel: false,
      recognizedAt: new Date().toISOString()
    }
    setSessionPatterns((prev) => [...prev, entry])
    setDescription('')
    setCurrentRecognition(null)
    setVariantNote('')
  }

  const handleAcceptSystem = () => {
    if (
      !currentRecognition ||
      currentRecognition.is_genuine_miss ||
      !currentRecognition.flows?.length
    )
      return
    const sourceDescription = description.trim()
    const systemTag = `[system] ${sourceDescription.slice(0, 80)}${
      sourceDescription.length > 80 ? '…' : ''
    }`
    const systemSummary = currentRecognition.summary || ''
    const newEntries = (currentRecognition.flows || []).map((f) => ({
      id: crypto.randomUUID(),
      canonicalName: f.label || '(unlabeled flow)',
      trigger: f.trigger,
      grammar: f.grammar || '',
      entitiesInvolved: f.entities || [],
      actorsInvolved: currentRecognition.actors_involved || [],
      variantNotes: systemSummary ? [systemSummary] : [],
      originalDescription: systemTag,
      systemSummary,
      isNovel: false,
      recognizedAt: new Date().toISOString()
    }))
    setSessionPatterns((prev) => [...prev, ...newEntries])
    setDescription('')
    setCurrentRecognition(null)
    setVariantNote('')
  }

  const handleClear = () => {
    setDescription('')
    setCurrentRecognition(null)
    setVariantNote('')
  }

  const handleRemoveEntity = (id) =>
    setSessionEntities((prev) => prev.filter((e) => e.id !== id))
  const handleRemovePattern = (id) =>
    setSessionPatterns((prev) => prev.filter((p) => p.id !== id))

  const buildMarkdown = () => {
    let md = `# Entities & patterns session\n\n_Generated ${new Date()
      .toISOString()
      .slice(0, 10)}_\n\n`
    if (sessionEntities.length > 0) {
      md += `## Entities\n\n`
      sessionEntities.forEach((e) => {
        md += `### ${e.canonicalName}\n\n`
        md += `_${ENTITY_CATEGORIES[e.category]?.name || e.category || 'uncategorized'}_\n\n`
        if (e.touchesVerbs.length > 0)
          md += `**Touches verbs:** ${e.touchesVerbs
            .map((v) => VERB_HOMES[v]?.name || v)
            .join(', ')}\n\n`
        if (e.actorRoles.length > 0)
          md += `**Actor roles:**\n${e.actorRoles
            .map((a) => `- ${ACTOR_ARCHETYPES[a.archetype]?.name || a.archetype}: ${a.label}`)
            .join('\n')}\n\n`
        if (e.constraints.length > 0)
          md += `**Constraints:**\n${e.constraints.map((c) => `- ${c}`).join('\n')}\n\n`
        if (e.typicalPatterns.length > 0)
          md += `**Typical patterns:** ${e.typicalPatterns.join(', ')}\n\n`
        if (e.variantNotes.length > 0)
          md += `**Variant traits:**\n${e.variantNotes.map((v) => `- ${v}`).join('\n')}\n\n`
        md += `_Originally:_ "${e.originalDescription}"\n\n`
      })
    }
    if (sessionPatterns.length > 0) {
      md += `## Patterns\n\n`
      sessionPatterns.forEach((p) => {
        md += `### ${p.canonicalName}\n\n`
        md += `**Grammar:** ${p.grammar}\n\n`
        if (p.entitiesInvolved.length > 0)
          md += `**Entities involved:** ${p.entitiesInvolved.join(', ')}\n\n`
        if (p.actorsInvolved.length > 0)
          md += `**Actors:**\n${p.actorsInvolved
            .map((a) => `- ${ACTOR_ARCHETYPES[a.archetype]?.name || a.archetype}: ${a.label}`)
            .join('\n')}\n\n`
        if (p.variantNotes.length > 0)
          md += `**Variant traits:**\n${p.variantNotes.map((v) => `- ${v}`).join('\n')}\n\n`
        md += `_Originally:_ "${p.originalDescription}"\n\n`
      })
    }
    return md
  }

  const copyToClipboard = async (text) => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text)
        return true
      }
    } catch (e) {
      /* fall through */
    }
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.left = '-9999px'
      ta.style.top = '0'
      ta.setAttribute('readonly', '')
      document.body.appendChild(ta)
      ta.select()
      ta.setSelectionRange(0, text.length)
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch (e) {
      return false
    }
  }

  const handleCopy = async () => {
    const ok = await copyToClipboard(buildMarkdown())
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } else {
      setError('Copy failed — clipboard blocked in this context')
      setTimeout(() => setError(null), 2500)
    }
  }

  const buildAudit = () => {
    const r = currentRecognition
    if (!r) return ''
    const inCat = (n) => (isInCatalog(n) ? '✓ in catalog' : '✗ off-catalog')
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19)
    let md = `# Recognition audit · ${
      mode === 'entity' ? 'Entity' : mode === 'system' ? 'System' : 'Pattern'
    } mode\n\n`
    md += `_${ts} UTC_\n\n`
    md += `## Input\n\n\`\`\`\n${description}\n\`\`\`\n\n`
    if ((mode === 'pattern' || mode === 'system') && sessionEntities.length > 0) {
      md += `## Session context (passed to model)\n\nAlready-recognized entities in this session:\n`
      sessionEntities.forEach((e) => {
        md += `- ${e.canonicalName}\n`
      })
      md += `\n`
    }
    md += `---\n\n`

    if (mode === 'system') {
      // ── Summary
      md += `## Summary\n\n`
      if (r.is_genuine_miss) {
        md += `_Genuine miss — model returned no decomposition._\n\n`
      } else if (r.summary) {
        md += `${r.summary}\n\n`
      } else {
        md += `_(no summary)_\n\n`
      }

      // ── Flows
      const flows = r.flows || []
      if (flows.length > 0) {
        md += `## Flows (${flows.length})\n\n`
        flows.forEach((f, i) => {
          md += `### ${i + 1}. ${f.label || '(unlabeled)'} · ${f.trigger || '?'} trigger\n\n`
          if (f.grammar) md += `\`\`\`\n${f.grammar}\n\`\`\`\n\n`
          const fents = f.entities || []
          if (fents.length > 0) {
            md += `entities: ${fents.map((e) => `${e} (${inCat(e)})`).join(', ')}\n\n`
          }
        })
      }

      // ── Entities involved (union across flows)
      const sysEntities = unionFlowEntities(flows)
      // shared = appears in 2+ flows
      const flowCounts = {}
      flows.forEach((f) =>
        new Set(f.entities || []).forEach((e) => {
          flowCounts[e] = (flowCounts[e] || 0) + 1
        })
      )
      const sharedEntities = Object.keys(flowCounts).filter((e) => flowCounts[e] >= 2)
      if (sysEntities.length > 0) {
        md += `## Entities involved (${sysEntities.length})\n\n`
        sysEntities.forEach((e) => {
          const sh = sharedEntities.includes(e)
            ? ` · shared across ${flowCounts[e]} flows`
            : ''
          md += `- ${e} (${inCat(e)})${sh}\n`
        })
        md += `\n`
      }

      // ── Actors
      const sysActors = r.actors_involved || []
      if (sysActors.length > 0) {
        md += `## Actors\n\n`
        sysActors.forEach((a) => {
          md += `- **${a.archetype}**: ${a.label}\n`
        })
        md += `\n`
      }

      // ── Aggregates
      const novelSysEntities = sysEntities.filter((e) => !isInCatalog(e))
      md += `## Aggregates\n\n`
      md += `- **flows:** ${flows.length}\n`
      md += `- **entities:** ${sysEntities.length} total · ${
        sysEntities.length - novelSysEntities.length
      } in catalog · ${novelSysEntities.length} novel\n`
      if (novelSysEntities.length > 0) md += `  - novel: ${novelSysEntities.join(', ')}\n`
      if (sharedEntities.length > 0)
        md += `  - shared across flows: ${sharedEntities.join(', ')}\n`
      md += `- **actors:** ${sysActors.length}\n\n`

      // ── Miss flags
      md += `## Miss flags\n\n`
      md += `- is_genuine_miss: ${r.is_genuine_miss === true}\n\n`

      md += `---\n\n## Raw model output\n\n\`\`\`json\n${JSON.stringify(
        r,
        null,
        2
      )}\n\`\`\`\n`
      return md
    }

    if (mode === 'entity') {
      if (r.verdict) {
        md += `## Verdict (3-question heuristic)\n\n`
        md += `- **kind:** ${r.verdict.kind || '(missing)'}\n`
        md += `- **parent:** ${
          r.verdict.parent
            ? `${r.verdict.parent} (${
                r.verdict.parent && isInCatalog(r.verdict.parent)
                  ? '✓ in catalog'
                  : '✗ off-catalog'
              })`
            : 'null'
        }\n`
        md += `- **reasoning:** ${r.verdict.reasoning || '(missing)'}\n\n`
      } else {
        md += `## Verdict\n\n_(model did not return a verdict object — heuristic skipped)_\n\n`
      }
    }

    md += `## Match\n\n`
    if (r.match) {
      const matchInCat =
        mode === 'entity'
          ? r.match.name
            ? isInCatalog(r.match.name)
              ? '✓ in catalog'
              : '✗ off-catalog'
            : ''
          : r.match.id
          ? PATTERN_CATALOG.find((p) => p.id === r.match.id)
            ? `✓ in catalog (id: ${r.match.id})`
            : `✗ off-catalog (id: ${r.match.id})`
          : ''
      md += `- **name:** ${r.match.name || 'null'}${matchInCat ? ` (${matchInCat})` : ''}\n`
      if (mode === 'entity' && r.match.name) {
        const cat = ENTITY_CATALOG.find((e) => e.name === r.match.name)?.category
        const catMeta = ENTITY_CATEGORIES[cat]
        md += `- **category:** ${catMeta ? `${catMeta.name} (${catMeta.tier})` : 'null'}\n`
      }
      if (mode === 'pattern') md += `- **id:** ${r.match.id || 'null'}\n`
      md += `- **confidence:** ${r.match.confidence ?? 'null'}/5\n`
      md += `- **why:** ${r.match.why || '(empty)'}\n\n`
      if (mode === 'pattern') {
        const canon = r.match.id ? PATTERN_CATALOG.find((p) => p.id === r.match.id) : null
        const cellMismatch =
          canon && (canon.trigger !== r.match.trigger || canon.verb !== r.match.verb)
        md += `### Grid cell\n\n`
        md += `- **trigger (model):** ${r.match.trigger || '(missing)'}\n`
        md += `- **verb (model):** ${r.match.verb || '(missing)'}\n`
        if (canon) {
          md += `- **canonical cell:** ${canon.trigger}×${canon.verb}\n`
          md += `- **cell match:** ${
            cellMismatch
              ? '✗ MISMATCH — model assigned different cell than catalog'
              : '✓ matches catalog'
          }\n`
        }
        md += `\n`
      }
    } else {
      md += `_(no match block)_\n\n`
    }

    if (mode === 'pattern' && r.match?.id) {
      const canonical = PATTERN_CATALOG.find((p) => p.id === r.match.id)
      if (canonical) {
        const canonicalSet = new Set(canonical.entities)
        const returnedSet = new Set(r.entities_involved || [])
        const missing = canonical.entities.filter((e) => !returnedSet.has(e))
        const extra = (r.entities_involved || []).filter((e) => !canonicalSet.has(e))
        md += `## Catalog-anchor coverage check\n\n`
        md += `Canonical entities for **${canonical.name}**: ${canonical.entities.join(
          ', '
        )}\n\n`
        if (missing.length === 0) {
          md += `- ✓ All canonical entities present in entities_involved\n`
        } else {
          md += `- ✗ Missing from entities_involved: ${missing.join(', ')}\n`
        }
        if (extra.length > 0) {
          md += `- Domain-specific additions: ${extra.join(', ')}\n`
        }
        md += `\n`
      }
    }

    if (mode === 'pattern') {
      if (r.grammar) md += `## Grammar (filled)\n\n\`${r.grammar}\`\n\n`
      if (r.entities_involved?.length) {
        md += `## Entities involved\n\n`
        r.entities_involved.forEach((e) => {
          md += `- ${e} (${inCat(e)})\n`
        })
        md += `\n`
      }
      if (r.actors_involved?.length) {
        md += `## Actors involved\n\n`
        r.actors_involved.forEach((a) => {
          md += `- **${a.archetype}**: ${a.label}\n`
        })
        md += `\n`
      }
      if (r.common_variations?.length) {
        md += `## Common variations\n\n`
        r.common_variations.forEach((v) => {
          md += `- ${v}\n`
        })
        md += `\n`
      }
    }

    if (r.variant_traits?.length) {
      md += `## Variant traits\n\n`
      r.variant_traits.forEach((t) => {
        md += `- ${t}\n`
      })
      md += `\n`
    }
    if (mode === 'entity' && r.touches_verbs?.length) {
      md += `## Touches verbs\n\n`
      r.touches_verbs.forEach((v) => {
        md += `- ${VERB_HOMES[v]?.name || v} (${v})\n`
      })
      md += `\n`
    }
    if (mode === 'entity' && r.actor_roles?.length) {
      md += `## Actor roles\n\n`
      r.actor_roles.forEach((a) => {
        md += `- **${a.archetype}**: ${a.label}\n`
      })
      md += `\n`
    }
    if (r.constraints?.length) {
      md += `## Constraints\n\n`
      r.constraints.forEach((c) => {
        md += `- ${c}\n`
      })
      md += `\n`
    }
    if (mode === 'entity' && r.typical_patterns?.length) {
      md += `## Typical patterns\n\n`
      r.typical_patterns.forEach((p) => {
        const pat = PATTERN_CATALOG.find((x) => x.id === p)
        md += `- ${pat?.name || p} (id: ${p})${pat ? '' : ' — ✗ unknown id'}\n`
      })
      md += `\n`
    }
    if (mode === 'entity' && r.typical_neighbors?.length) {
      md += `## Typical neighbors\n\n`
      r.typical_neighbors.forEach((n) => {
        md += `- ${n} (${inCat(n)})\n`
      })
      md += `\n`
    }
    if (mode === 'entity' && r.detected_transitions?.length) {
      const ent = r.match?.name ? ENTITY_CATALOG.find((e) => e.name === r.match.name) : null
      const canonical = ent?.transitions || []
      const canonicalKeys = new Set(canonical.map((t) => `${t.from}→${t.to}`))
      md += `## Detected transitions\n\n`
      r.detected_transitions.forEach((t) => {
        const key = `${t.from}→${t.to}`
        const matchesCanonical = canonicalKeys.has(key)
        md += `- \`${t.from} → ${t.to}\` — ${t.trigger || '(no trigger)'}\n`
        md += `  - in_canonical_set (model): ${t.in_canonical_set === true}\n`
        md += `  - matches catalog canonical: ${matchesCanonical ? '✓ yes' : '✗ no'}${
          !matchesCanonical && canonical.length > 0 ? ' — off-canonical or variant' : ''
        }\n`
        if (t.is_inferred) md += `  - is_inferred: true\n`
      })
      if (canonical.length > 0) {
        const detectedKeys = new Set(r.detected_transitions.map((t) => `${t.from}→${t.to}`))
        const unused = canonical.filter((t) => !detectedKeys.has(`${t.from}→${t.to}`))
        if (unused.length > 0) {
          md += `\n_Canonical transitions not present in this scenario (for reference):_\n`
          unused.forEach((t) => {
            md += `- \`${t.from} → ${t.to}\` (${t.trigger})\n`
          })
        }
      }
      md += `\n`
    }
    if (mode === 'pattern' && r.detected_modifiers?.length) {
      md += `## Detected modifiers\n\n`
      r.detected_modifiers.forEach((m) => {
        const canonical = MODIFIERS.find((x) => x.id === m.id)
        md += `- **${canonical?.name || m.id}**${
          canonical ? '' : ' — ✗ unknown modifier id'
        }\n`
        md += `  - why: ${m.why || '(none)'}\n`
        if (canonical) md += `  - typically applies to: ${canonical.applies_to.join(', ')}\n`
      })
      md += `\n`
    }
    if (mode === 'pattern' && r.key_transitions?.length) {
      md += `## Key transitions\n\n`
      r.key_transitions.forEach((t) => {
        const ent = t.entity ? ENTITY_CATALOG.find((e) => e.name === t.entity) : null
        const canonicalKeys = ent?.transitions
          ? new Set(ent.transitions.map((c) => `${c.from}→${c.to}`))
          : null
        const matchesCanonical = canonicalKeys ? canonicalKeys.has(`${t.from}→${t.to}`) : null
        md += `- **${t.entity || '(no entity)'}** \`${t.from} → ${t.to}\` — role: ${
          t.role || 'unspecified'
        }\n`
        md += `  - trigger: ${t.trigger || '(none)'}\n`
        md += `  - entity in catalog: ${
          t.entity ? (isInCatalog(t.entity) ? '✓' : '✗') : 'n/a'
        }\n`
        md += `  - in_canonical_set (model): ${t.in_canonical_set === true}\n`
        if (canonicalKeys !== null) {
          md += `  - matches catalog canonical: ${matchesCanonical ? '✓ yes' : '✗ no'}\n`
        } else if (t.entity) {
          md += `  - matches catalog canonical: n/a (entity has no canonical transitions defined)\n`
        }
      })
      md += `\n`
    }
    if (r.alternatives?.length) {
      md += `## Alternatives considered\n\n`
      r.alternatives.forEach((a) => {
        md += `- **${a.name}**${a.name && isInCatalog(a.name) ? ' (✓ in catalog)' : ''}\n`
        if (a.why_considered) md += `  - considered: ${a.why_considered}\n`
        if (a.why_rejected) md += `  - rejected: ${a.why_rejected}\n`
      })
      md += `\n`
    }
    md += `## Miss flags\n\n`
    md += `- is_genuine_miss: ${r.is_genuine_miss === true}\n`
    const sn = mode === 'entity' ? r.suggested_new_entity : r.suggested_new_pattern
    md += `- ${mode === 'entity' ? 'suggested_new_entity' : 'suggested_new_pattern'}: ${
      sn ? JSON.stringify(sn) : 'null'
    }\n\n`

    md += `---\n\n## Raw model output\n\n\`\`\`json\n${JSON.stringify(r, null, 2)}\n\`\`\`\n`
    return md
  }

  const handleCopyAudit = async () => {
    const ok = await copyToClipboard(buildAudit())
    if (ok) {
      setAuditCopied(true)
      setTimeout(() => setAuditCopied(false), 1500)
    } else {
      setError('Copy failed — clipboard blocked in this context')
      setTimeout(() => setError(null), 2500)
    }
  }

  // Implementation hints per modifier — separate from MODIFIERS catalog which
  // describes meaning. These describe what the modifier obliges in code.
  const MODIFIER_OBLIGATIONS = {
    async: [
      'Pattern must run via background worker / queue, not inline in the request path.',
      'Caller returns immediately after enqueueing; the result is delivered out-of-band.'
    ],
    idempotency: [
      'Pattern must be safe to replay.',
      'Use a stable idempotency key derived from a source entity (e.g., `Visit.id + operation`).',
      'A second execution with the same key must produce the same observable result as the first — not duplicate side-effects.'
    ],
    listener: [
      'Recipients are not addressed directly; resolve via Listener records that registered interest.',
      'On dispatch, query active Listeners matching the event source and fan out to each.'
    ],
    cancellation: [
      'Pattern is a reverse-direction Cascade — identify the forward action it undoes.',
      'Register a reverse-transition handler that propagates the undo across the same entities the forward action touched.'
    ],
    compensation: [
      'On failure mid-flow, run the registered compensating action(s) to restore prior state.',
      'Typically used in Saga-style patterns where work spans services that cannot share a transaction.'
    ]
  }

  // Build "planning notes" markdown: structured raw material for a HUMAN
  // to use while writing a task spec. Deliberately NOT framed as a finished
  // spec — research shows auto-generated context artifacts hurt agent
  // performance because they suffer from context blindness (coherent but
  // incompatible with the actual codebase). The framing in the header is
  // load-bearing; don't drop it.
  const buildPlanningNotes = () => {
    const r = currentRecognition
    if (!r || mode !== 'system' || r.is_genuine_miss) return ''

    const title = (r.summary || description.trim() || 'Untitled system')
      .split(/[.!?\n]/)[0]
      .trim()
      .slice(0, 80)

    let md = `# Planning notes: ${title}\n\n`
    md += `> **This is raw material for writing a spec — not a spec itself.**\n>\n`
    md += `> The framework recognized patterns from your description, but it does not know your codebase. It cannot tell you which existing services to reuse, what tests to write, what helpers already exist, or which constraints already apply. Use this as a structured starting point and apply codebase knowledge before handing anything to an agent. Auto-generated context artifacts have been shown to *reduce* agent task success when handed over as-is.\n\n`

    md += `## Input\n\n`
    md += `> ${description.trim().split('\n').join('\n> ')}\n\n`

    if (r.summary) {
      md += `## What this system does\n\n${r.summary}\n\n`
    }

    const patterns = r.patterns || []
    if (patterns.length > 0) {
      md += `## Patterns identified (${patterns.length})\n\n`
      patterns.forEach((p, i) => {
        const canon = p.id ? PATTERN_CATALOG.find((x) => x.id === p.id) : null
        const cellMismatch = canon && (canon.trigger !== p.trigger || canon.verb !== p.verb)
        const modStr = (p.modifiers || [])
          .map((m) => `+${MODIFIERS.find((x) => x.id === m.id)?.name || m.id}`)
          .join(' ')

        md += `### ${i + 1}. ${p.name || p.id}${modStr ? ` ${modStr}` : ''}\n\n`
        md += `- **Cell:** ${p.trigger || '?'} × ${p.verb || '?'}`
        if (cellMismatch)
          md += ` ⚠ (catalog canonical for ${canon.name}: ${canon.trigger} × ${canon.verb})`
        md += `\n`
        if (p.why) md += `- **What it does:** ${p.why}\n`
        if (p.grammar) md += `- **Grammar:** \`${p.grammar}\`\n`

        const ents = p.entities_involved || []
        if (ents.length > 0) md += `- **Touches:** ${ents.join(', ')}\n`

        if (canon && canon.entities && canon.entities.length > 0) {
          const returnedSet = new Set(ents)
          const missing = canon.entities.filter((e) => !returnedSet.has(e))
          if (missing.length === 0) {
            md += `- **Catalog contract:** all canonical entities present (${canon.entities.join(
              ', '
            )}).\n`
          } else {
            md += `- **Catalog contract:** canonical for ${
              canon.name
            } is ${canon.entities.join(', ')}. Currently missing: **${missing.join(
              ', '
            )}** — decide if these belong in the implementation, or note explicitly why they don't.\n`
          }
        }

        const actors = p.actors_involved || []
        if (actors.length > 0) {
          md += `- **Actors:** ${actors
            .map((a) => `${a.label} (${a.archetype})`)
            .join(', ')}\n`
        }
        md += `\n`
      })
    }

    const interactions = r.interactions || []
    if (interactions.length > 0) {
      md += `## Pattern flow\n\nHow the patterns chain together — read this top to bottom as the rough implementation reading order:\n\n`
      interactions.forEach((it) => {
        const via = it.via ? ` via \`${it.via}\`` : ''
        const kind = it.kind ? ` (${it.kind})` : ''
        md += `- \`${it.from}\` → \`${it.to}\`${via}${kind}\n`
      })
      md += `\n`
    }

    // Collect unique modifier usage across patterns
    const modifierUsage = {}
    patterns.forEach((p) => {
      ;(p.modifiers || []).forEach((m) => {
        if (!m.id) return
        if (!modifierUsage[m.id]) modifierUsage[m.id] = []
        modifierUsage[m.id].push(p.name || p.id)
      })
    })

    if (Object.keys(modifierUsage).length > 0) {
      md += `## Modifier obligations\n\nModifiers tag implementation requirements that go beyond the base pattern. Honor these in code or the system will misbehave under load / failure:\n\n`
      Object.entries(modifierUsage).forEach(([modId, patternsUsing]) => {
        const modMeta = MODIFIERS.find((m) => m.id === modId)
        const obligations = MODIFIER_OBLIGATIONS[modId] || [
          '(No standard obligations defined for this modifier — review its semantics in the catalog.)'
        ]
        md += `### +${modMeta?.name || modId} (applies to: ${[...new Set(patternsUsing)].join(
          ', '
        )})\n\n`
        obligations.forEach((o) => {
          md += `- ${o}\n`
        })
        md += `\n`
      })
    }

    md += `## Things to decide before drafting the spec\n\n`
    md += `The framework didn't (and can't) answer these. Resolve them with codebase knowledge before writing the spec:\n\n`
    md += `- [ ] **Existing services.** Which entities above already have services in the codebase? Which are new? Reusing existing services almost always beats parallel implementations.\n`
    md += `- [ ] **Existing helpers.** Is there already a queue/worker abstraction for \`+async\`? An idempotency helper for \`+idempotency\`? A Listener-resolution helper? Use them rather than inventing parallel mechanisms.\n`
    md += `- [ ] **Test strategy.** What's the existing test pattern — unit, integration, fixtures, factories? The spec should reference the specific testing conventions, not "write tests".\n`
    md += `- [ ] **Auth & permissions.** What permissions are required for each new trigger / endpoint / pattern? Match existing scoping conventions.\n`
    md += `- [ ] **Rollout.** Feature flagged? Dark launch? Big bang? The spec needs a deploy plan, not just a "ship" line.\n`
    md += `- [ ] **Observability.** What metrics, traces, or logs does this need — especially for the failure paths in the DAG above?\n`
    md += `- [ ] **External failure handling.** Modifiers cover in-pattern obligations. What about external-facing failures — partial outages, third-party API downtime, malformed inbound data?\n`
    md += `- [ ] **Cell mismatches** (if any flagged above). The model placed at least one pattern in a non-canonical cell. Decide whether the variation is real (your scenario genuinely shifts the trigger/verb) or whether the recognition drifted.\n\n`

    if (r.system_grammar) {
      md += `## System grammar (reference)\n\nFor the spec's narrative section, the formal flow as the framework reads it:\n\n`
      md += `\`\`\`\n${r.system_grammar}\n\`\`\`\n\n`
    }

    md += `---\n\n_Generated from system-mode recognition. Apply codebase knowledge before drafting the spec._\n`
    return md
  }

  const handleCopyPlanningNotes = async () => {
    const ok = await copyToClipboard(buildPlanningNotes())
    if (ok) {
      setPlanningNotesCopied(true)
      setTimeout(() => setPlanningNotesCopied(false), 1500)
    } else {
      setError('Copy failed — clipboard blocked in this context')
      setTimeout(() => setError(null), 2500)
    }
  }

  const handleDownload = () => {
    const blob = new Blob([buildMarkdown()], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `entities-patterns-${Date.now()}.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  const catalogByCategory = useMemo(() => {
    const byCategory = {}
    // Pre-seed in ENTITY_CATEGORIES order so insertion order matches Core→Domain
    Object.keys(ENTITY_CATEGORIES).forEach((k) => {
      byCategory[k] = []
    })
    ENTITY_CATALOG.forEach((e) => {
      if (!byCategory[e.category]) byCategory[e.category] = []
      byCategory[e.category].push(e)
    })
    // Strip empty buckets (none currently, but defensive)
    Object.keys(byCategory).forEach((k) => {
      if (byCategory[k].length === 0) delete byCategory[k]
    })
    return byCategory
  }, [])

  const catalogSearchActive = catalogSearch.trim().length > 0
  const filteredCatalogByCategory = useMemo(() => {
    const q = catalogSearch.trim().toLowerCase()
    if (!q) return catalogByCategory
    const byCategory = {}
    Object.keys(ENTITY_CATEGORIES).forEach((k) => {
      byCategory[k] = []
    })
    ENTITY_CATALOG.forEach((e) => {
      const hay = [
        e.name,
        e.desc,
        e.example || '',
        (e.neighbors || []).join(' '),
        (e.props || []).join(' '),
        (e.actors || []).join(' ')
      ]
        .join(' ')
        .toLowerCase()
      if (!hay.includes(q)) return
      if (!byCategory[e.category]) byCategory[e.category] = []
      byCategory[e.category].push(e)
    })
    Object.keys(byCategory).forEach((k) => {
      if (byCategory[k].length === 0) delete byCategory[k]
    })
    return byCategory
  }, [catalogSearch, catalogByCategory])

  const filteredCatalogCount = useMemo(
    () => Object.values(filteredCatalogByCategory).reduce((s, arr) => s + arr.length, 0),
    [filteredCatalogByCategory]
  )

  const filteredCatalogFlat = useMemo(() => {
    const all = Object.values(filteredCatalogByCategory).flat()
    return all.sort((a, b) => a.name.localeCompare(b.name))
  }, [filteredCatalogByCategory])

  const totalCount = sessionEntities.length + sessionPatterns.length

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Spectral:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500&family=JetBrains+Mono:wght@400;500;600&display=swap');

        .ep-app { background: #15130F; color: #E8E2D2; min-height: 100vh; font-family: 'Spectral', Georgia, serif; }
        .ep-serif { font-family: 'Spectral', Georgia, serif; }
        .ep-mono { font-family: 'JetBrains Mono', monospace; }
        .ep-muted { color: #8A8273; }

        .ep-c-entity { color: #B5AC9F; }
        .ep-c-verb { color: #3FA77F; }
        .ep-c-actor { color: #9582C0; }
        .ep-c-constraint { color: #D49852; }
        .ep-c-pattern { color: #B85A3A; }

        .ep-bg-entity { background: rgba(181,172,159,0.06); border-color: rgba(181,172,159,0.25); }
        .ep-bg-verb { background: rgba(63,167,127,0.07); border-color: rgba(63,167,127,0.3); }
        .ep-bg-actor { background: rgba(149,130,192,0.07); border-color: rgba(149,130,192,0.3); }
        .ep-bg-constraint { background: rgba(212,152,82,0.07); border-color: rgba(212,152,82,0.3); }
        .ep-bg-pattern { background: rgba(184,90,58,0.07); border-color: rgba(184,90,58,0.3); }

        .ep-label { font-family: 'JetBrains Mono', monospace; font-size: 10.5px; letter-spacing: 0.16em; text-transform: uppercase; color: #8A8273; font-weight: 500; }
        .ep-h1 { font-family: 'Spectral', serif; font-weight: 500; font-size: 42px; line-height: 1; color: #E8E2D2; letter-spacing: -0.015em; font-style: italic; }
        .ep-h2 { font-family: 'Spectral', serif; font-weight: 500; font-size: 24px; color: #E8E2D2; }
        .ep-h3 { font-family: 'Spectral', serif; font-weight: 600; font-size: 18px; color: #E8E2D2; }

        .ep-textarea {
          background: rgba(30,27,21,0.7); border: 1px solid rgba(232,226,210,0.18); color: #E8E2D2;
          font-family: 'Spectral', serif; font-size: 16px; line-height: 1.55; padding: 14px 16px;
          border-radius: 3px; width: 100%; resize: vertical; outline: none; transition: all 150ms ease;
        }
        .ep-textarea:focus { border-color: #B85A3A; background: rgba(30,27,21,0.95); box-shadow: 0 0 0 3px rgba(184,90,58,0.08); }
        .ep-textarea::placeholder { color: #5C564B; font-style: italic; }

        .ep-input {
          background: rgba(30,27,21,0.8); border: 1px solid rgba(232,226,210,0.2); padding: 7px 11px;
          border-radius: 3px; font-family: 'Spectral', serif; font-size: 14.5px; color: #E8E2D2; width: 100%; outline: none;
        }
        .ep-input:focus { border-color: #B85A3A; }

        .ep-btn {
          font-family: 'JetBrains Mono', monospace; font-size: 11.5px; font-weight: 500; letter-spacing: 0.08em;
          text-transform: uppercase; padding: 9px 16px; background: #E8E2D2; color: #15130F;
          border: 1px solid #E8E2D2; border-radius: 2px; cursor: pointer; transition: all 150ms ease;
          display: inline-flex; align-items: center; gap: 7px;
        }
        .ep-btn:hover:not(:disabled) { background: #B85A3A; border-color: #B85A3A; }
        .ep-btn:disabled { opacity: 0.35; cursor: not-allowed; }
        .ep-btn-ghost { background: transparent; color: #E8E2D2; border: 1px solid rgba(232,226,210,0.28); }
        .ep-btn-ghost:hover:not(:disabled) { border-color: #E8E2D2; background: rgba(232,226,210,0.04); }
        .ep-btn-sm { padding: 5px 11px; font-size: 10.5px; gap: 5px; }

        .ep-mode-toggle { display: inline-flex; border: 1px solid rgba(232,226,210,0.2); border-radius: 3px; overflow: hidden; }
        .ep-mode-btn {
          padding: 8px 16px; font-family: 'JetBrains Mono', monospace; font-size: 11px;
          letter-spacing: 0.1em; text-transform: uppercase; background: transparent; color: #E8E2D2;
          border: none; cursor: pointer; transition: all 150ms ease; display: inline-flex; align-items: center; gap: 6px;
        }
        .ep-mode-btn:hover:not(.active) { background: rgba(232,226,210,0.05); }
        .ep-mode-btn.active.entity { background: #B5AC9F; color: #15130F; }
        .ep-mode-btn.active.pattern { background: #B85A3A; color: #15130F; }

        .ep-card { background: #1E1B15; border: 1px solid rgba(232,226,210,0.14); border-radius: 3px; padding: 22px 24px; }
        .ep-card-entity { border: 2px solid #B5AC9F; }
        .ep-card-pattern { border: 2px solid #B85A3A; }

        .ep-acc-item { background: #1E1B15; border: 1px solid rgba(232,226,210,0.12); border-radius: 3px; padding: 11px 13px; transition: border-color 150ms ease; }
        .ep-acc-item:hover { border-color: rgba(232,226,210,0.3); }
        .ep-acc-item.pattern { border-left: 3px solid #B85A3A; }

        .ep-pill { display: inline-block; padding: 3px 9px; background: rgba(232,226,210,0.05); border: 1px solid rgba(232,226,210,0.15); font-family: 'JetBrains Mono', monospace; font-size: 10.5px; color: #E8E2D2; border-radius: 2px; letter-spacing: 0.02em; }
        .ep-pill-verb { background: rgba(63,167,127,0.08); border-color: rgba(63,167,127,0.3); color: #3FA77F; }
        .ep-pill-actor { background: rgba(149,130,192,0.08); border-color: rgba(149,130,192,0.3); color: #9582C0; }
        .ep-pill-pattern { background: rgba(184,90,58,0.08); border-color: rgba(184,90,58,0.3); color: #B85A3A; }
        .ep-pill-entity { background: rgba(181,172,159,0.06); border-color: rgba(181,172,159,0.3); color: #B5AC9F; }
        .ep-pill-entity-novel {
          background: rgba(184,90,58,0.06); border: 1px dashed rgba(184,90,58,0.55); color: #B85A3A;
          padding: 3px 9px; font-family: 'JetBrains Mono', monospace; font-size: 10.5px;
          border-radius: 2px; letter-spacing: 0.02em; display: inline-block;
        }

        .ep-confidence-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 3px; border: 1px solid currentColor; }
        .ep-confidence-dot.filled { background: currentColor; }

        .ep-cat-entry { padding: 6px 10px; font-family: 'JetBrains Mono', monospace; font-size: 12px; color: #E8E2D2; border-radius: 2px; cursor: pointer; transition: all 100ms ease; display: block; width: 100%; text-align: left; background: transparent; border: none; }
        .ep-cat-entry:hover { background: rgba(232,226,210,0.04); }
        .ep-cat-entry.selected.entity { background: rgba(181,172,159,0.1); color: #B5AC9F; font-weight: 600; }
        .ep-cat-entry.selected.pattern { background: rgba(184,90,58,0.1); color: #B85A3A; font-weight: 600; }

        .ep-verb-header { cursor: pointer; padding: 7px 10px; background: transparent; border: none; width: 100%; text-align: left; font-family: 'JetBrains Mono', monospace; font-size: 10.5px; letter-spacing: 0.14em; text-transform: uppercase; color: #E8E2D2; font-weight: 600; display: flex; align-items: center; justify-content: space-between; border-radius: 2px; transition: background 100ms ease; }
        .ep-verb-header:hover { background: rgba(232,226,210,0.04); }

        .ep-sidebar-tab { font-family: 'JetBrains Mono', monospace; font-size: 10.5px; letter-spacing: 0.12em; text-transform: uppercase; padding: 6px 12px; cursor: pointer; background: transparent; border: none; color: #8A8273; transition: all 150ms ease; }
        .ep-sidebar-tab.active { color: #E8E2D2; border-bottom: 2px solid #B85A3A; }

        .ep-grammar {
          font-family: 'JetBrains Mono', monospace; font-size: 13.5px; line-height: 1.7;
          padding: 12px 14px; background: rgba(184,90,58,0.04); border-left: 3px solid #B85A3A;
          border-radius: 2px; color: #E8E2D2;
        }

        .ep-chip {
          font-family: 'Spectral', serif; font-size: 12.5px; font-style: italic;
          padding: 4px 11px; background: rgba(232,226,210,0.04); border: 1px solid rgba(232,226,210,0.15);
          border-radius: 999px; color: #8A8273; cursor: pointer; transition: all 150ms ease;
        }
        .ep-chip:hover:not(:disabled) { background: rgba(184,90,58,0.08); border-color: rgba(184,90,58,0.35); color: #B85A3A; }
        .ep-chip:disabled { opacity: 0.4; cursor: not-allowed; }

        .ep-dot { animation: epBlink 1.4s infinite ease-in-out; display: inline-block; }
        .ep-dot:nth-child(2) { animation-delay: 0.2s; }
        .ep-dot:nth-child(3) { animation-delay: 0.4s; }
        @keyframes epBlink { 0%, 80%, 100% { opacity: 0.2; } 40% { opacity: 1; } }

        .ep-fade-in { animation: epFade 400ms ease-out; }
        @keyframes epFade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>

      {view === 'graph' ? (
        <GraphView
          onBack={() => setView('recognizer')}
          sessionEntities={sessionEntities}
          sessionPatterns={sessionPatterns}
        />
      ) : (
        <div className="ep-app">
          <div className="max-w-7xl mx-auto px-6 md:px-10 py-8 md:py-12">
            <header className="mb-8">
              <div className="flex items-end justify-between flex-wrap gap-4 mb-5">
                <div>
                  <div className="ep-label mb-2 flex items-center gap-2">
                    <BookOpen size={11} /> Information Systems Solutions Framework
                  </div>
                  <h1 className="ep-h1">Find the Solution infrastructure</h1>
                </div>
                {totalCount > 0 && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => setView('graph')}
                      className="ep-btn ep-btn-ghost ep-btn-sm">
                      <Network size={11} /> Graph
                    </button>
                    <button onClick={handleCopy} className="ep-btn ep-btn-ghost ep-btn-sm">
                      {copied ? (
                        <>
                          <Check size={11} /> Copied
                        </>
                      ) : (
                        <>
                          <Copy size={11} /> Copy
                        </>
                      )}
                    </button>
                    <button
                      onClick={handleDownload}
                      className="ep-btn ep-btn-ghost ep-btn-sm">
                      <Download size={11} /> .md
                    </button>
                  </div>
                )}
                {totalCount === 0 && (
                  <button
                    onClick={() => setView('graph')}
                    className="ep-btn ep-btn-ghost ep-btn-sm">
                    <Network size={11} /> View catalog graph
                  </button>
                )}
              </div>

              <div className="ep-mode-toggle mb-4">
                <button
                  onClick={() => {
                    setMode('system')
                    setCurrentRecognition(null)
                  }}
                  className={`ep-mode-btn pattern ${mode === 'system' ? 'active' : ''}`}
                  title="Describe a system; get its operational grammar over the entity catalog">
                  <Layers size={11} /> System
                </button>
                <button
                  onClick={() => {
                    setMode('entity')
                    setCurrentRecognition(null)
                  }}
                  className={`ep-mode-btn entity ${mode === 'entity' ? 'active' : ''}`}>
                  <Box size={11} /> Entity
                </button>
              </div>

              <p
                className="ep-serif ep-muted"
                style={{
                  fontSize: 15,
                  lineHeight: 1.55,
                  maxWidth: 680,
                  fontStyle: 'italic'
                }}>
                {mode === 'entity'
                  ? 'Describe a thing you\u2019re working with. The catalog tries to recognize it and surfaces its dimensions — tier and category, touched verbs, actor roles, constraints.'
                  : 'Describe a feature, workflow, or capability. The catalog reads it as a grammar of operations over your entities — what comes in, what changes, what goes out — with the boundary crossings lit up.'}
              </p>
            </header>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
              <section className="lg:col-span-8 space-y-5">
                <div>
                  <div className="ep-label mb-2">
                    {mode === 'entity'
                      ? 'Describe the thing'
                      : mode === 'system'
                      ? 'Describe the system or feature'
                      : 'Describe the interaction'}
                  </div>
                  <textarea
                    rows={mode === 'system' ? 5 : 3}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder={
                      mode === 'entity'
                        ? 'e.g. Customers will be able to track their cleaning visits and see when the crew is on the way…'
                        : mode === 'system'
                        ? 'e.g. Customers book recurring cleaning visits and receive reminders before each one. Their card is automatically charged after each completed visit. They can cancel anytime through their account, which stops future visits and refunds the most recent charge if applicable…'
                        : 'e.g. When a customer books a cleaning visit, the system schedules it, assigns a crew, and sends a confirmation. The day before, a reminder goes out…'
                    }
                    className="ep-textarea"
                    disabled={isRecognizing}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault()
                        handleRecognize()
                      }
                    }}
                  />
                  <div className="mt-3 flex items-center gap-2 flex-wrap">
                    <span className="ep-label" style={{ marginRight: 2 }}>
                      Try:
                    </span>
                    {(mode === 'entity'
                      ? ENTITY_EXAMPLES
                      : mode === 'system'
                      ? SYSTEM_EXAMPLES
                      : PATTERN_EXAMPLES
                    ).map((ex, i) => (
                      <button
                        key={i}
                        onClick={() => {
                          setDescription(ex.text)
                          setCurrentRecognition(null)
                        }}
                        className="ep-chip"
                        disabled={isRecognizing}>
                        {ex.label}
                      </button>
                    ))}
                  </div>
                  <div className="mt-3 flex items-center gap-2 flex-wrap">
                    <button
                      onClick={handleRecognize}
                      disabled={!description.trim() || isRecognizing}
                      className="ep-btn">
                      {isRecognizing ? (
                        <>
                          <Loader2 size={11} className="animate-spin" /> Recognizing
                        </>
                      ) : (
                        <>
                          <Search size={11} /> Recognize
                        </>
                      )}
                    </button>
                    {(description || currentRecognition) && !isRecognizing && (
                      <button onClick={handleClear} className="ep-btn ep-btn-ghost ep-btn-sm">
                        <X size={11} /> Clear
                      </button>
                    )}
                    {currentRecognition && !isRecognizing && (
                      <button
                        onClick={handleCopyAudit}
                        className="ep-btn ep-btn-ghost ep-btn-sm"
                        title="Copy diagnostic markdown for review">
                        {auditCopied ? (
                          <>
                            <Check size={11} /> Audit copied
                          </>
                        ) : (
                          <>
                            <Copy size={11} /> Copy audit
                          </>
                        )}
                      </button>
                    )}
                    <span
                      className="ep-muted ep-serif"
                      style={{ fontSize: 12.5, fontStyle: 'italic', marginLeft: 'auto' }}>
                      ⌘+Enter
                    </span>
                  </div>
                </div>

                {error && (
                  <div
                    className="ep-fade-in"
                    style={{
                      padding: '10px 14px',
                      background: 'rgba(216,85,64,0.08)',
                      border: '1px solid rgba(216,85,64,0.3)',
                      borderRadius: 3,
                      color: '#D85540',
                      fontSize: 13,
                      fontFamily: 'JetBrains Mono, monospace'
                    }}>
                    <AlertCircle
                      size={13}
                      style={{ display: 'inline-block', verticalAlign: -2, marginRight: 6 }}
                    />{' '}
                    {error}
                  </div>
                )}

                {isRecognizing && (
                  <div
                    className="ep-muted ep-mono ep-fade-in"
                    style={{ fontSize: 12.5, padding: '14px 0' }}>
                    Consulting the {mode === 'entity' ? 'entity' : 'pattern'} catalog{' '}
                    <span className="ep-dot">·</span>
                    <span className="ep-dot">·</span>
                    <span className="ep-dot">·</span>
                  </div>
                )}

                {currentRecognition &&
                  !currentRecognition.is_genuine_miss &&
                  mode === 'system' &&
                  currentRecognition.flows?.length > 0 && (
                    <div className="ep-card ep-card-pattern ep-fade-in">
                      <div
                        className="ep-label"
                        style={{
                          fontSize: 9.5,
                          opacity: 0.6,
                          letterSpacing: '0.12em',
                          marginBottom: 10
                        }}>
                        System · {currentRecognition.flows.length} flow
                        {currentRecognition.flows.length === 1 ? '' : 's'}
                      </div>

                      {currentRecognition.summary && (
                        <p
                          className="ep-serif"
                          style={{
                            fontSize: 16,
                            lineHeight: 1.5,
                            fontStyle: 'italic',
                            marginBottom: 18
                          }}>
                          {currentRecognition.summary}
                        </p>
                      )}

                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 12,
                          marginBottom: 6
                        }}>
                        {currentRecognition.flows.map((flow, fi) => {
                          const trig = TRIGGERS[flow.trigger]
                          const trigColor =
                            SYSTEM_DAG_TRIGGER_COLORS[flow.trigger] || '#8A8273'
                          return (
                            <div
                              key={fi}
                              style={{
                                border: '1px solid rgba(232,226,210,0.1)',
                                borderLeft: `3px solid ${trigColor}`,
                                borderRadius: '0 4px 4px 0',
                                padding: '12px 14px',
                                background: 'rgba(232,226,210,0.02)'
                              }}>
                              <div
                                className="flex items-center gap-2 flex-wrap"
                                style={{ marginBottom: 8 }}>
                                <span
                                  className="ep-pill"
                                  style={{
                                    background: `${trigColor}18`,
                                    borderColor: `${trigColor}55`,
                                    color: trigColor,
                                    fontSize: 9,
                                    letterSpacing: '0.06em',
                                    textTransform: 'uppercase'
                                  }}>
                                  {trig?.name || flow.trigger || '?'} trigger
                                </span>
                                <span
                                  className="ep-serif"
                                  style={{
                                    fontSize: 14,
                                    fontStyle: 'italic',
                                    color: '#E8E2D2'
                                  }}>
                                  {flow.label}
                                </span>
                              </div>
                              {flow.grammar && (
                                <GrammarText
                                  block
                                  style={{
                                    fontSize: 12,
                                    lineHeight: 1.8,
                                    padding: '8px 10px',
                                    overflowX: 'auto'
                                  }}>
                                  {flow.grammar}
                                </GrammarText>
                              )}
                              {flow.entities?.length > 0 && (
                                <div
                                  className="flex items-center gap-1 flex-wrap"
                                  style={{ marginTop: 8 }}>
                                  {flow.entities.map((e, ei) =>
                                    isInCatalog(e) ? (
                                      <span
                                        key={ei}
                                        className="ep-pill ep-pill-entity"
                                        style={{ fontSize: 9 }}
                                        title="In catalog">
                                        {e}
                                      </span>
                                    ) : (
                                      <span
                                        key={ei}
                                        className="ep-pill-entity-novel"
                                        style={{ fontSize: 9 }}
                                        title="Not in catalog">
                                        {e}
                                      </span>
                                    )
                                  )}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>

                      <div
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: 14,
                          marginBottom: 4,
                          fontSize: 10,
                          fontFamily: 'JetBrains Mono, monospace',
                          color: '#8A8273'
                        }}>
                        <span
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <span style={{ color: '#7AA8C2' }}>↓</span> inbound
                        </span>
                        <span
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <span style={{ color: '#D49852' }}>↑</span> outbound
                        </span>
                        <span
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <span style={{ color: '#7F77DD' }}>⇅</span> exchange
                        </span>
                        <span
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <span style={{ color: '#B5AC9F' }}>●</span> mutates
                        </span>
                        <span
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <span style={{ color: '#B5AC9F' }}>○</span> reads
                        </span>
                      </div>

                      {(() => {
                        const allEntities = unionFlowEntities(currentRecognition.flows)
                        const shared = (() => {
                          const counts = {}
                          currentRecognition.flows.forEach((f) =>
                            new Set(f.entities || []).forEach((e) => {
                              counts[e] = (counts[e] || 0) + 1
                            })
                          )
                          return Object.keys(counts).filter((e) => counts[e] >= 2)
                        })()
                        return allEntities.length > 0 ? (
                          <Section label={`Entities involved (${allEntities.length})`}>
                            <div className="flex flex-wrap gap-1">
                              {allEntities.map((e, i) =>
                                isInCatalog(e) ? (
                                  <span
                                    key={i}
                                    className="ep-pill ep-pill-entity"
                                    title={
                                      shared.includes(e)
                                        ? 'Shared across flows'
                                        : 'In catalog'
                                    }
                                    style={
                                      shared.includes(e)
                                        ? { outline: '1px solid rgba(127,119,221,0.5)' }
                                        : undefined
                                    }>
                                    {e}
                                  </span>
                                ) : (
                                  <span
                                    key={i}
                                    className="ep-pill-entity-novel"
                                    title="Not in catalog">
                                    {e}
                                  </span>
                                )
                              )}
                            </div>
                            {shared.length > 0 && (
                              <div
                                className="ep-mono"
                                style={{ fontSize: 9.5, color: '#8A8273', marginTop: 6 }}>
                                <span style={{ color: '#7F77DD' }}>outlined</span> = shared
                                across 2+ flows (the connective tissue)
                              </div>
                            )}
                          </Section>
                        ) : null
                      })()}

                      {currentRecognition.actors_involved?.length > 0 && (
                        <Section label="Actors">
                          <div className="flex flex-wrap gap-1.5">
                            {currentRecognition.actors_involved.map((a, i) => (
                              <span key={i} className="ep-serif" style={{ fontSize: 12.5 }}>
                                <span
                                  className="ep-pill ep-pill-actor"
                                  style={{ marginRight: 4 }}>
                                  {ACTOR_ARCHETYPES[a.archetype]?.name || a.archetype}
                                </span>
                                <span>{a.label}</span>
                              </span>
                            ))}
                          </div>
                        </Section>
                      )}

                      <div
                        className="pt-3"
                        style={{ borderTop: '1px solid rgba(232,226,210,0.14)' }}>
                        <button onClick={handleAcceptSystem} className="ep-btn">
                          <Check size={11} /> Save ({currentRecognition.flows.length}){' '}
                          {currentRecognition.flows.length === 1 ? 'system' : 'systems'} to
                          session
                        </button>
                      </div>
                    </div>
                  )}

                {currentRecognition &&
                  !currentRecognition.is_genuine_miss &&
                  currentRecognition.match?.name &&
                  mode === 'entity' && (
                    <div className="ep-card ep-card-entity ep-fade-in">
                      <div className="flex items-start justify-between gap-3 mb-3">
                        <div>
                          <div className="ep-label mb-1">Best entity match</div>
                          <div className="flex items-baseline gap-3 flex-wrap">
                            <span className="ep-mono ep-h2" style={{ fontSize: 24 }}>
                              {currentRecognition.match.name}
                            </span>
                            {(() => {
                              const cat = ENTITY_CATALOG.find(
                                (e) => e.name === currentRecognition.match.name
                              )?.category
                              const catMeta = ENTITY_CATEGORIES[cat]
                              return catMeta ? (
                                <span className="ep-pill ep-pill-verb">
                                  {catMeta.name} · {catMeta.tier}
                                </span>
                              ) : null
                            })()}
                          </div>
                        </div>
                        <div className="text-right shrink-0 ep-c-entity">
                          <div className="ep-label mb-1">Confidence</div>
                          <div>
                            {[1, 2, 3, 4, 5].map((n) => (
                              <span
                                key={n}
                                className={`ep-confidence-dot ${
                                  n <= currentRecognition.match.confidence ? 'filled' : ''
                                }`}
                              />
                            ))}
                          </div>
                        </div>
                      </div>

                      <p
                        className="ep-serif ep-muted mb-4"
                        style={{ fontSize: 14.5, lineHeight: 1.55, fontStyle: 'italic' }}>
                        {currentRecognition.match.why}
                      </p>

                      {currentRecognition.verdict?.kind && (
                        <Section label="Recognition reasoning">
                          <div className="flex items-center gap-2 flex-wrap mb-1.5">
                            {currentRecognition.verdict.kind === 'property' && (
                              <>
                                <span className="ep-pill ep-pill-constraint">Property</span>
                                {currentRecognition.verdict.parent && (
                                  <>
                                    <span
                                      className="ep-serif ep-muted"
                                      style={{ fontSize: 13, fontStyle: 'italic' }}>
                                      of
                                    </span>
                                    {isInCatalog(currentRecognition.verdict.parent) ? (
                                      <span
                                        className="ep-pill ep-pill-entity"
                                        title="In catalog">
                                        {currentRecognition.verdict.parent}
                                      </span>
                                    ) : (
                                      <span
                                        className="ep-pill-entity-novel"
                                        title="Not in catalog">
                                        {currentRecognition.verdict.parent}
                                      </span>
                                    )}
                                  </>
                                )}
                              </>
                            )}
                            {currentRecognition.verdict.kind === 'variant' && (
                              <>
                                <span className="ep-pill ep-pill-entity">Variant</span>
                                {currentRecognition.verdict.parent && (
                                  <>
                                    <span
                                      className="ep-serif ep-muted"
                                      style={{ fontSize: 13, fontStyle: 'italic' }}>
                                      of
                                    </span>
                                    {isInCatalog(currentRecognition.verdict.parent) ? (
                                      <span
                                        className="ep-pill ep-pill-entity"
                                        title="In catalog">
                                        {currentRecognition.verdict.parent}
                                      </span>
                                    ) : (
                                      <span
                                        className="ep-pill-entity-novel"
                                        title="Not in catalog">
                                        {currentRecognition.verdict.parent}
                                      </span>
                                    )}
                                  </>
                                )}
                              </>
                            )}
                            {currentRecognition.verdict.kind === 'novel' && (
                              <span className="ep-pill ep-pill-pattern">Genuinely novel</span>
                            )}
                          </div>
                          {currentRecognition.verdict.reasoning && (
                            <p
                              className="ep-serif ep-muted"
                              style={{
                                fontSize: 13,
                                lineHeight: 1.5,
                                fontStyle: 'italic',
                                margin: 0
                              }}>
                              {currentRecognition.verdict.reasoning}
                            </p>
                          )}
                        </Section>
                      )}

                      {currentRecognition.variant_traits?.length > 0 && (
                        <Section label="Your variant traits">
                          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                            {currentRecognition.variant_traits.map((t, i) => (
                              <li
                                key={i}
                                className="ep-serif"
                                style={{
                                  fontSize: 14,
                                  fontStyle: 'italic',
                                  marginBottom: 4,
                                  paddingLeft: 14,
                                  position: 'relative'
                                }}>
                                <span
                                  style={{ position: 'absolute', left: 0, color: '#B5AC9F' }}>
                                  ·
                                </span>
                                {t}
                              </li>
                            ))}
                          </ul>
                        </Section>
                      )}

                      {currentRecognition.touches_verbs?.length > 0 && (
                        <Section label="Also touches verbs">
                          <div className="flex flex-wrap gap-1.5">
                            {currentRecognition.touches_verbs.map((v, i) => (
                              <span key={i} className="ep-pill ep-pill-verb">
                                {VERB_HOMES[v]?.name || v}
                              </span>
                            ))}
                          </div>
                        </Section>
                      )}

                      {currentRecognition.actor_roles?.length > 0 && (
                        <Section label="Actor roles">
                          <div className="space-y-1.5">
                            {currentRecognition.actor_roles.map((a, i) => (
                              <div
                                key={i}
                                className="ep-serif"
                                style={{ fontSize: 14, lineHeight: 1.5 }}>
                                <span
                                  className="ep-pill ep-pill-actor"
                                  style={{ marginRight: 8 }}>
                                  {ACTOR_ARCHETYPES[a.archetype]?.name || a.archetype}
                                </span>
                                <span>{a.label}</span>
                              </div>
                            ))}
                          </div>
                        </Section>
                      )}

                      {currentRecognition.constraints?.length > 0 && (
                        <Section label="Typical constraints">
                          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                            {currentRecognition.constraints.map((c, i) => (
                              <li
                                key={i}
                                className="ep-serif ep-c-constraint"
                                style={{
                                  fontSize: 13.5,
                                  fontStyle: 'italic',
                                  marginBottom: 3,
                                  paddingLeft: 14,
                                  position: 'relative'
                                }}>
                                <span style={{ position: 'absolute', left: 0 }}>!</span>
                                {c}
                              </li>
                            ))}
                          </ul>
                        </Section>
                      )}

                      {currentRecognition.typical_patterns?.length > 0 && (
                        <Section label="Typical patterns it participates in">
                          <div className="flex flex-wrap gap-1.5">
                            {currentRecognition.typical_patterns.map((p, i) => {
                              const pat = PATTERN_CATALOG.find((x) => x.id === p)
                              return (
                                <span key={i} className="ep-pill ep-pill-pattern">
                                  {pat?.name || p}
                                </span>
                              )
                            })}
                          </div>
                        </Section>
                      )}

                      {currentRecognition.typical_neighbors?.length > 0 && (
                        <Section label="Often paired with">
                          <div className="flex flex-wrap gap-1.5 items-center">
                            {currentRecognition.typical_neighbors.map((n, i) =>
                              isInCatalog(n) ? (
                                <span
                                  key={i}
                                  className="ep-pill ep-pill-entity"
                                  title="In catalog">
                                  {n}
                                </span>
                              ) : (
                                <span
                                  key={i}
                                  className="ep-pill-entity-novel"
                                  title="Not in catalog — candidate for adding">
                                  {n}
                                </span>
                              )
                            )}
                            {currentRecognition.typical_neighbors.some(
                              (n) => !isInCatalog(n)
                            ) && (
                              <span
                                className="ep-serif ep-muted"
                                style={{ fontSize: 12, fontStyle: 'italic', marginLeft: 4 }}>
                                (dashed = not in catalog)
                              </span>
                            )}
                          </div>
                        </Section>
                      )}

                      {currentRecognition.detected_transitions?.length > 0 && (
                        <Section label="Transitions">
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {currentRecognition.detected_transitions.map((t, i) => (
                              <div
                                key={i}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  flexWrap: 'wrap',
                                  gap: 6,
                                  fontFamily: 'JetBrains Mono, monospace',
                                  fontSize: 12
                                }}>
                                <span
                                  className="ep-pill"
                                  style={{ background: 'rgba(181,172,159,0.07)' }}>
                                  {t.from}
                                </span>
                                <span style={{ color: '#8A8273' }}>→</span>
                                <span
                                  className="ep-pill"
                                  style={{
                                    background: 'rgba(181,172,159,0.12)',
                                    borderColor: 'rgba(232,226,210,0.25)'
                                  }}>
                                  {t.to}
                                </span>
                                {t.in_canonical_set === false && (
                                  <span
                                    title="Not in entity's canonical transition set"
                                    style={{
                                      color: '#B85A3A',
                                      fontSize: 10.5,
                                      letterSpacing: '0.05em'
                                    }}>
                                    ○ off-canonical
                                  </span>
                                )}
                                {t.trigger && (
                                  <span
                                    className="ep-serif ep-muted"
                                    style={{ fontStyle: 'italic', fontSize: 12 }}>
                                    via {t.trigger}
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        </Section>
                      )}

                      <div
                        className="pt-3"
                        style={{ borderTop: '1px solid rgba(232,226,210,0.14)' }}>
                        <input
                          type="text"
                          value={variantNote}
                          onChange={(e) => setVariantNote(e.target.value)}
                          placeholder="Add your own variant note (optional)…"
                          className="ep-input mb-3"
                        />
                        <button onClick={handleAcceptEntity} className="ep-btn">
                          <Check size={11} /> Accept entity
                        </button>
                      </div>
                    </div>
                  )}

                {currentRecognition &&
                  !currentRecognition.is_genuine_miss &&
                  currentRecognition.match?.name &&
                  mode === 'pattern' && (
                    <div className="ep-card ep-card-pattern ep-fade-in">
                      {/* ──── PHASE 1: OVERVIEW — build toward the decision ──── */}

                      <div
                        className="ep-label"
                        style={{
                          fontSize: 9.5,
                          opacity: 0.6,
                          letterSpacing: '0.12em',
                          marginBottom: 10
                        }}>
                        Overview
                      </div>

                      {currentRecognition.grammar && (
                        <Section label="Grammar">
                          <GrammarText>{currentRecognition.grammar}</GrammarText>
                        </Section>
                      )}

                      {currentRecognition.entities_involved?.length > 0 && (
                        <Section label="Entities involved">
                          <div className="flex flex-wrap gap-1.5 items-center">
                            {currentRecognition.entities_involved.map((e, i) =>
                              isInCatalog(e) ? (
                                <span
                                  key={i}
                                  className="ep-pill ep-pill-entity"
                                  title="In catalog">
                                  {e}
                                </span>
                              ) : (
                                <span
                                  key={i}
                                  className="ep-pill-entity-novel"
                                  title="Not in catalog — candidate for adding">
                                  {e}
                                </span>
                              )
                            )}
                            {currentRecognition.entities_involved.some(
                              (e) => !isInCatalog(e)
                            ) && (
                              <span
                                className="ep-serif ep-muted"
                                style={{ fontSize: 12, fontStyle: 'italic', marginLeft: 4 }}>
                                (dashed = not in catalog)
                              </span>
                            )}
                          </div>
                        </Section>
                      )}

                      {currentRecognition.actors_involved?.length > 0 && (
                        <Section label="Actors involved">
                          <div className="space-y-1.5">
                            {currentRecognition.actors_involved.map((a, i) => (
                              <div
                                key={i}
                                className="ep-serif"
                                style={{ fontSize: 14, lineHeight: 1.5 }}>
                                <span
                                  className="ep-pill ep-pill-actor"
                                  style={{ marginRight: 8 }}>
                                  {ACTOR_ARCHETYPES[a.archetype]?.name || a.archetype}
                                </span>
                                <span>{a.label}</span>
                              </div>
                            ))}
                          </div>
                        </Section>
                      )}

                      {currentRecognition.detected_modifiers?.length > 0 && (
                        <Section label="Modifiers in play">
                          <div className="space-y-1.5">
                            {currentRecognition.detected_modifiers.map((m, i) => {
                              const canonical = MODIFIERS.find((x) => x.id === m.id)
                              return (
                                <div
                                  key={i}
                                  className="ep-serif"
                                  style={{ fontSize: 13.5, lineHeight: 1.5 }}>
                                  <span
                                    className="ep-pill"
                                    style={{
                                      background: 'rgba(184,90,58,0.10)',
                                      borderColor: 'rgba(184,90,58,0.30)',
                                      marginRight: 8
                                    }}>
                                    {canonical?.name || m.id}
                                  </span>
                                  <span className="ep-muted" style={{ fontStyle: 'italic' }}>
                                    {m.why}
                                  </span>
                                </div>
                              )
                            })}
                          </div>
                        </Section>
                      )}

                      {/* ──── DECISION MOMENT ──── */}

                      <div
                        style={{
                          margin: '24px 0 14px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 12
                        }}>
                        <div
                          style={{ flex: 1, height: 1, background: 'rgba(184,90,58,0.25)' }}
                        />
                        <div
                          className="ep-label"
                          style={{
                            fontSize: 9.5,
                            color: '#B85A3A',
                            letterSpacing: '0.14em',
                            whiteSpace: 'nowrap'
                          }}>
                          ↓ recognized as
                        </div>
                        <div
                          style={{ flex: 1, height: 1, background: 'rgba(184,90,58,0.25)' }}
                        />
                      </div>

                      <div
                        style={{
                          padding: '16px 18px',
                          background: 'rgba(184,90,58,0.04)',
                          borderLeft: '3px solid rgba(184,90,58,0.5)',
                          borderRadius: '0 3px 3px 0'
                        }}>
                        <div className="flex items-start justify-between gap-3 mb-2">
                          <div style={{ flex: 1 }}>
                            {(currentRecognition.match.trigger ||
                              currentRecognition.match.verb) &&
                              (() => {
                                const canon = PATTERN_CATALOG.find(
                                  (p) => p.id === currentRecognition.match.id
                                )
                                const cellMismatch =
                                  canon &&
                                  (canon.trigger !== currentRecognition.match.trigger ||
                                    canon.verb !== currentRecognition.match.verb)
                                return (
                                  <div
                                    className="flex items-center gap-1.5 mb-2 flex-wrap"
                                    style={{ fontSize: 11 }}>
                                    <span className="ep-label" style={{ fontSize: 9.5 }}>
                                      cell
                                    </span>
                                    <span
                                      className="ep-pill"
                                      style={{
                                        background: 'rgba(92,184,144,0.10)',
                                        borderColor: 'rgba(92,184,144,0.30)'
                                      }}>
                                      {TRIGGERS[currentRecognition.match.trigger]?.name ||
                                        currentRecognition.match.trigger ||
                                        '?'}
                                    </span>
                                    <span style={{ color: '#8A8273' }}>×</span>
                                    <span className="ep-pill ep-pill-verb">
                                      {VERB_HOMES[currentRecognition.match.verb]?.name ||
                                        currentRecognition.match.verb ||
                                        '?'}
                                    </span>
                                    {cellMismatch && (
                                      <span
                                        title={`Catalog says this pattern lives at ${canon.trigger}×${canon.verb}`}
                                        style={{
                                          color: '#B85A3A',
                                          fontSize: 10.5,
                                          marginLeft: 4
                                        }}>
                                        ⚠ catalog cell: {canon.trigger}×{canon.verb}
                                      </span>
                                    )}
                                  </div>
                                )
                              })()}
                            <div
                              className="ep-h2 ep-c-pattern"
                              style={{ fontSize: 28, fontStyle: 'italic', lineHeight: 1.1 }}>
                              {currentRecognition.match.name}
                            </div>
                          </div>
                          <div className="text-right shrink-0 ep-c-pattern">
                            <div className="ep-label mb-1">Confidence</div>
                            <div>
                              {[1, 2, 3, 4, 5].map((n) => (
                                <span
                                  key={n}
                                  className={`ep-confidence-dot ${
                                    n <= currentRecognition.match.confidence ? 'filled' : ''
                                  }`}
                                />
                              ))}
                            </div>
                          </div>
                        </div>

                        {currentRecognition.match.why && (
                          <p
                            className="ep-serif ep-muted"
                            style={{
                              fontSize: 14,
                              lineHeight: 1.55,
                              fontStyle: 'italic',
                              margin: '8px 0 0'
                            }}>
                            {currentRecognition.match.why}
                          </p>
                        )}
                      </div>

                      {/* ──── PHASE 2: DETAILS — supporting evidence ──── */}

                      {(currentRecognition.variant_traits?.length > 0 ||
                        currentRecognition.common_variations?.length > 0 ||
                        currentRecognition.key_transitions?.length > 0) && (
                        <div style={{ marginTop: 28, marginBottom: 4 }}>
                          <div
                            className="ep-label"
                            style={{ fontSize: 9.5, opacity: 0.6, letterSpacing: '0.14em' }}>
                            Details
                          </div>
                        </div>
                      )}

                      {currentRecognition.variant_traits?.length > 0 && (
                        <Section label="Your variant traits">
                          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                            {currentRecognition.variant_traits.map((t, i) => (
                              <li
                                key={i}
                                className="ep-serif"
                                style={{
                                  fontSize: 14,
                                  fontStyle: 'italic',
                                  marginBottom: 4,
                                  paddingLeft: 14,
                                  position: 'relative'
                                }}>
                                <span
                                  style={{ position: 'absolute', left: 0, color: '#B85A3A' }}>
                                  ·
                                </span>
                                {t}
                              </li>
                            ))}
                          </ul>
                        </Section>
                      )}

                      {currentRecognition.common_variations?.length > 0 && (
                        <Section label="Common variations of this pattern">
                          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                            {currentRecognition.common_variations.map((v, i) => (
                              <li
                                key={i}
                                className="ep-serif ep-muted"
                                style={{
                                  fontSize: 13.5,
                                  fontStyle: 'italic',
                                  marginBottom: 3,
                                  paddingLeft: 14,
                                  position: 'relative'
                                }}>
                                <span
                                  style={{ position: 'absolute', left: 0, color: '#B85A3A' }}>
                                  ~
                                </span>
                                {v}
                              </li>
                            ))}
                          </ul>
                        </Section>
                      )}

                      {currentRecognition.key_transitions?.length > 0 && (
                        <Section label="Key transitions">
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {currentRecognition.key_transitions.map((t, i) => (
                              <div
                                key={i}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  flexWrap: 'wrap',
                                  gap: 6,
                                  fontFamily: 'JetBrains Mono, monospace',
                                  fontSize: 12
                                }}>
                                {t.entity &&
                                  (isInCatalog(t.entity) ? (
                                    <span
                                      className="ep-pill ep-pill-entity"
                                      title="In catalog">
                                      {t.entity}
                                    </span>
                                  ) : (
                                    <span
                                      className="ep-pill-entity-novel"
                                      title="Not in catalog">
                                      {t.entity}
                                    </span>
                                  ))}
                                <span
                                  className="ep-pill"
                                  style={{ background: 'rgba(181,172,159,0.07)' }}>
                                  {t.from}
                                </span>
                                <span style={{ color: '#8A8273' }}>→</span>
                                <span
                                  className="ep-pill"
                                  style={{
                                    background: 'rgba(181,172,159,0.12)',
                                    borderColor: 'rgba(232,226,210,0.25)'
                                  }}>
                                  {t.to}
                                </span>
                                {t.role && (
                                  <span
                                    className="ep-pill"
                                    style={{
                                      background:
                                        t.role === 'entry'
                                          ? 'rgba(92,184,144,0.12)'
                                          : t.role === 'effect'
                                          ? 'rgba(184,90,58,0.10)'
                                          : 'rgba(181,172,159,0.12)',
                                      fontSize: 9.5,
                                      letterSpacing: '0.05em',
                                      textTransform: 'uppercase'
                                    }}>
                                    {t.role}
                                  </span>
                                )}
                                {t.in_canonical_set === false && (
                                  <span
                                    title="Not in entity's canonical transition set"
                                    style={{
                                      color: '#B85A3A',
                                      fontSize: 10.5,
                                      letterSpacing: '0.05em'
                                    }}>
                                    ○ off-canonical
                                  </span>
                                )}
                                {t.trigger && (
                                  <span
                                    className="ep-serif ep-muted"
                                    style={{ fontStyle: 'italic', fontSize: 12 }}>
                                    via {t.trigger}
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        </Section>
                      )}

                      <div
                        className="pt-3"
                        style={{ borderTop: '1px solid rgba(232,226,210,0.14)' }}>
                        <input
                          type="text"
                          value={variantNote}
                          onChange={(e) => setVariantNote(e.target.value)}
                          placeholder="Add your own variant note (optional)…"
                          className="ep-input mb-3"
                        />
                        <button onClick={handleAcceptPattern} className="ep-btn">
                          <Check size={11} /> Accept pattern
                        </button>
                      </div>
                    </div>
                  )}

                {currentRecognition?.is_genuine_miss && (
                  <div
                    className="ep-card ep-fade-in"
                    style={{ borderStyle: 'dashed', borderColor: 'rgba(184,90,58,0.5)' }}>
                    <div className="ep-label mb-2 ep-c-pattern flex items-center gap-2">
                      <Sparkles size={12} /> Genuine miss — catalog has no clean match
                    </div>
                    <p
                      className="ep-serif ep-muted"
                      style={{ fontSize: 14, lineHeight: 1.5, fontStyle: 'italic' }}>
                      Nothing in the {mode} catalog fits. This might be genuinely novel. For
                      now, refine the description and try again, or note it externally —
                      adding to the catalog is a future feature.
                    </p>
                  </div>
                )}
              </section>

              <aside className="lg:col-span-4">
                <div
                  className="flex gap-1 mb-4"
                  style={{ borderBottom: '1px solid rgba(232,226,210,0.14)' }}>
                  <button
                    onClick={() => setSidebarTab('session')}
                    className={`ep-sidebar-tab ${sidebarTab === 'session' ? 'active' : ''}`}>
                    Session ({totalCount})
                  </button>
                  <button
                    onClick={() => setSidebarTab('catalog')}
                    className={`ep-sidebar-tab ${sidebarTab === 'catalog' ? 'active' : ''}`}>
                    Catalog
                  </button>
                  <button
                    onClick={() => setSidebarTab('list')}
                    className={`ep-sidebar-tab ${sidebarTab === 'list' ? 'active' : ''}`}>
                    List
                  </button>
                </div>

                {sidebarTab === 'session' && (
                  <div className="space-y-6">
                    <div>
                      <div className="ep-label mb-2 flex items-center gap-1.5">
                        <Box size={11} className="ep-c-entity" /> Entities (
                        {sessionEntities.length})
                      </div>
                      {sessionEntities.length === 0 ? (
                        <p
                          className="ep-serif ep-muted"
                          style={{ fontSize: 13, fontStyle: 'italic' }}>
                          Recognized entities collect here.
                        </p>
                      ) : (
                        <div className="space-y-2">
                          {sessionEntities.map((e) => (
                            <div key={e.id} className="ep-acc-item ep-fade-in">
                              <div className="flex items-start justify-between gap-2">
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-baseline gap-2 flex-wrap mb-1">
                                    <span
                                      className="ep-mono"
                                      style={{ fontSize: 13.5, fontWeight: 600 }}>
                                      {e.canonicalName}
                                    </span>
                                    <span
                                      className="ep-pill ep-pill-verb"
                                      style={{ fontSize: 9 }}>
                                      {ENTITY_CATEGORIES[e.category]?.name ||
                                        e.category ||
                                        ''}
                                    </span>
                                  </div>
                                  {e.actorRoles.length > 0 && (
                                    <div className="flex flex-wrap gap-1 mt-1">
                                      {e.actorRoles.map((a, i) => (
                                        <span
                                          key={i}
                                          className="ep-pill ep-pill-actor"
                                          style={{ fontSize: 9 }}>
                                          {a.label}
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                  {e.variantNotes.length > 0 && (
                                    <div
                                      className="mt-1.5 ep-serif ep-muted"
                                      style={{
                                        fontSize: 11.5,
                                        fontStyle: 'italic',
                                        lineHeight: 1.45
                                      }}>
                                      {e.variantNotes.slice(0, 2).join(' · ')}
                                    </div>
                                  )}
                                </div>
                                <button
                                  onClick={() => handleRemoveEntity(e.id)}
                                  style={{
                                    background: 'none',
                                    border: 'none',
                                    cursor: 'pointer',
                                    color: '#8A8273',
                                    padding: 0
                                  }}>
                                  <X size={13} />
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div>
                      <div className="ep-label mb-2 flex items-center gap-1.5">
                        <Zap size={11} className="ep-c-pattern" /> Systems (
                        {sessionPatterns.length})
                      </div>
                      {sessionPatterns.length === 0 ? (
                        <p
                          className="ep-serif ep-muted"
                          style={{ fontSize: 13, fontStyle: 'italic' }}>
                          Recognized systems collect here.
                        </p>
                      ) : (
                        <div className="space-y-2">
                          {sessionPatterns.map((p) => (
                            <div key={p.id} className="ep-acc-item pattern ep-fade-in">
                              <div className="flex items-start justify-between gap-2">
                                <div className="flex-1 min-w-0">
                                  <div
                                    className="ep-serif ep-c-pattern"
                                    style={{
                                      fontSize: 13.5,
                                      fontStyle: 'italic',
                                      fontWeight: 600,
                                      marginBottom: 4
                                    }}>
                                    {p.canonicalName}
                                  </div>
                                  <div
                                    className="ep-mono"
                                    style={{
                                      fontSize: 11,
                                      lineHeight: 1.5,
                                      color: '#B5AC9F'
                                    }}>
                                    {p.grammar}
                                  </div>
                                  {p.variantNotes.length > 0 && (
                                    <div
                                      className="mt-1.5 ep-serif ep-muted"
                                      style={{
                                        fontSize: 11.5,
                                        fontStyle: 'italic',
                                        lineHeight: 1.45
                                      }}>
                                      {p.variantNotes.slice(0, 2).join(' · ')}
                                    </div>
                                  )}
                                </div>
                                <button
                                  onClick={() => handleRemovePattern(p.id)}
                                  style={{
                                    background: 'none',
                                    border: 'none',
                                    cursor: 'pointer',
                                    color: '#8A8273',
                                    padding: 0
                                  }}>
                                  <X size={13} />
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {sidebarTab === 'catalog' && (
                  <div className="space-y-5">
                    <div>
                      <div style={{ position: 'relative', marginBottom: 12 }}>
                        <Search
                          size={11}
                          style={{
                            position: 'absolute',
                            left: 9,
                            top: '50%',
                            transform: 'translateY(-50%)',
                            color: '#8A8273',
                            pointerEvents: 'none'
                          }}
                        />
                        <input
                          type="text"
                          value={catalogSearch}
                          onChange={(e) => setCatalogSearch(e.target.value)}
                          placeholder="Search entities…"
                          className="ep-input"
                          style={{
                            paddingLeft: 26,
                            paddingRight: catalogSearchActive ? 26 : 10
                          }}
                        />
                        {catalogSearchActive && (
                          <button
                            onClick={() => setCatalogSearch('')}
                            style={{
                              position: 'absolute',
                              right: 6,
                              top: '50%',
                              transform: 'translateY(-50%)',
                              background: 'none',
                              border: 'none',
                              cursor: 'pointer',
                              color: '#8A8273',
                              padding: 4,
                              display: 'flex'
                            }}
                            title="Clear">
                            <X size={11} />
                          </button>
                        )}
                      </div>
                      <div className="ep-label mb-3 flex items-center gap-1.5">
                        <Box size={11} className="ep-c-entity" /> Entity archetypes
                        {catalogSearchActive && (
                          <span
                            className="ep-muted"
                            style={{ fontSize: 10, fontWeight: 400, letterSpacing: 0 }}>
                            ({filteredCatalogCount} of {ENTITY_CATALOG.length})
                          </span>
                        )}
                      </div>
                      {catalogSearchActive && filteredCatalogCount === 0 ? (
                        <p
                          className="ep-serif ep-muted"
                          style={{ fontSize: 13, fontStyle: 'italic' }}>
                          No matches.
                        </p>
                      ) : (
                        <div className="space-y-1">
                          {Object.entries(filteredCatalogByCategory).map(
                            ([category, entries]) => (
                              <div key={category}>
                                <button
                                  onClick={() =>
                                    setExpandedCategories((p) => ({
                                      ...p,
                                      [category]: !p[category]
                                    }))
                                  }
                                  className="ep-verb-header">
                                  <span>
                                    {ENTITY_CATEGORIES[category]?.name || category} ·{' '}
                                    {entries.length}
                                  </span>
                                  {catalogSearchActive || expandedCategories[category] ? (
                                    <ChevronDown size={11} />
                                  ) : (
                                    <ChevronRight size={11} />
                                  )}
                                </button>
                                {(catalogSearchActive || expandedCategories[category]) && (
                                  <div className="ep-fade-in" style={{ paddingLeft: 4 }}>
                                    {entries.map((e) => (
                                      <button
                                        key={e.name}
                                        onClick={() => {
                                          setSelectedCatalogEntity(
                                            selectedCatalogEntity?.name === e.name ? null : e
                                          )
                                          setSelectedCatalogPattern(null)
                                        }}
                                        className={`ep-cat-entry ${
                                          selectedCatalogEntity?.name === e.name
                                            ? 'selected entity'
                                            : ''
                                        }`}>
                                        {e.name}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )
                          )}
                        </div>
                      )}

                      {selectedCatalogEntity && (
                        <div
                          className="mt-3 ep-fade-in ep-bg-entity"
                          style={{
                            padding: '12px 14px',
                            border: '1px solid',
                            borderRadius: 3
                          }}>
                          <div className="ep-mono ep-h3 mb-1" style={{ fontSize: 15 }}>
                            {selectedCatalogEntity.name}
                          </div>
                          <p
                            className="ep-serif"
                            style={{
                              fontSize: 13,
                              lineHeight: 1.5,
                              fontStyle: 'italic',
                              marginBottom: 8
                            }}>
                            {selectedCatalogEntity.desc}
                          </p>
                          <div className="space-y-2">
                            <div>
                              <div className="ep-label mb-1" style={{ fontSize: 9.5 }}>
                                Touches
                              </div>
                              <div className="flex flex-wrap gap-1">
                                {selectedCatalogEntity.touches.map((v, i) => (
                                  <span
                                    key={i}
                                    className="ep-pill ep-pill-verb"
                                    style={{ fontSize: 9.5 }}>
                                    {VERB_HOMES[v]?.name || v}
                                  </span>
                                ))}
                              </div>
                            </div>
                            <div>
                              <div className="ep-label mb-1" style={{ fontSize: 9.5 }}>
                                Typical actors
                              </div>
                              <div className="flex flex-wrap gap-1">
                                {selectedCatalogEntity.actors.map((a, i) => (
                                  <span
                                    key={i}
                                    className="ep-pill ep-pill-actor"
                                    style={{ fontSize: 9.5 }}>
                                    {ACTOR_ARCHETYPES[a]?.name || a}
                                  </span>
                                ))}
                              </div>
                            </div>
                            <div>
                              <div className="ep-label mb-1" style={{ fontSize: 9.5 }}>
                                Typical patterns
                              </div>
                              <div className="flex flex-wrap gap-1">
                                {selectedCatalogEntity.patterns.map((p, i) => {
                                  const pat = PATTERN_CATALOG.find((x) => x.id === p)
                                  return (
                                    <span
                                      key={i}
                                      className="ep-pill ep-pill-pattern"
                                      style={{ fontSize: 9.5 }}>
                                      {pat?.name || p}
                                    </span>
                                  )
                                })}
                              </div>
                            </div>
                            {selectedCatalogEntity.kinds?.length > 0 && (
                              <div>
                                <div className="ep-label mb-1" style={{ fontSize: 9.5 }}>
                                  Catalog-blessed kinds ({selectedCatalogEntity.kinds.length})
                                </div>
                                <div className="flex flex-wrap gap-1">
                                  {selectedCatalogEntity.kinds.map((k, i) => (
                                    <span
                                      key={i}
                                      className="ep-pill ep-mono"
                                      style={{
                                        fontSize: 9.5,
                                        background: 'rgba(181,172,159,0.06)'
                                      }}>
                                      {selectedCatalogEntity.name}:{k}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}
                            {selectedCatalogEntity.transitions?.length > 0 && (
                              <div>
                                <div className="ep-label mb-1" style={{ fontSize: 9.5 }}>
                                  Canonical transitions (
                                  {selectedCatalogEntity.transitions.length})
                                </div>
                                <div
                                  style={{
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: 4
                                  }}>
                                  {selectedCatalogEntity.transitions.map((t, i) => (
                                    <div
                                      key={i}
                                      style={{
                                        fontFamily: 'JetBrains Mono, monospace',
                                        fontSize: 10.5,
                                        lineHeight: 1.4,
                                        display: 'flex',
                                        alignItems: 'center',
                                        flexWrap: 'wrap',
                                        gap: 4
                                      }}>
                                      <span style={{ color: '#B5AC9F' }}>{t.from}</span>
                                      <span style={{ color: '#8A8273' }}>→</span>
                                      <span style={{ color: '#E8E2D2', fontWeight: 500 }}>
                                        {t.to}
                                      </span>
                                      <span
                                        className="ep-serif ep-muted"
                                        style={{
                                          fontStyle: 'italic',
                                          fontSize: 10.5,
                                          marginLeft: 4
                                        }}>
                                        {t.trigger}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                            <div>
                              <div className="ep-label mb-1" style={{ fontSize: 9.5 }}>
                                Example
                              </div>
                              <p
                                className="ep-serif ep-muted"
                                style={{ fontSize: 12, fontStyle: 'italic' }}>
                                {selectedCatalogEntity.example}
                              </p>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>

                    <div
                      className="pt-4"
                      style={{ borderTop: '1px solid rgba(232,226,210,0.14)' }}>
                      <div className="ep-label mb-3 flex items-center gap-1.5">
                        <Zap size={11} className="ep-c-pattern" /> Pattern archetypes (
                        {PATTERN_CATALOG.length})
                      </div>
                      <div className="space-y-3">
                        {['user', 'time', 'state', 'external'].map((trig) => {
                          const inGroup = PATTERN_CATALOG.filter((p) => p.trigger === trig)
                          if (inGroup.length === 0) return null
                          return (
                            <div key={trig}>
                              <div
                                className="ep-label"
                                style={{ fontSize: 9.5, marginBottom: 4, opacity: 0.75 }}>
                                {TRIGGERS[trig].name}-initiated · {inGroup.length}
                              </div>
                              <div className="space-y-1">
                                {inGroup.map((p) => (
                                  <button
                                    key={p.id}
                                    onClick={() => {
                                      setSelectedCatalogPattern(
                                        selectedCatalogPattern?.id === p.id ? null : p
                                      )
                                      setSelectedCatalogEntity(null)
                                    }}
                                    className={`ep-cat-entry ${
                                      selectedCatalogPattern?.id === p.id
                                        ? 'selected pattern'
                                        : ''
                                    }`}
                                    style={{
                                      fontFamily: 'Spectral, serif',
                                      fontStyle: 'italic',
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'space-between'
                                    }}>
                                    <span>{p.name}</span>
                                    <span
                                      style={{
                                        fontFamily: 'JetBrains Mono, monospace',
                                        fontStyle: 'normal',
                                        fontSize: 9.5,
                                        color: '#8A8273',
                                        letterSpacing: '0.04em'
                                      }}>
                                      {p.verb}
                                    </span>
                                  </button>
                                ))}
                              </div>
                            </div>
                          )
                        })}
                      </div>

                      {selectedCatalogPattern && (
                        <div
                          className="mt-3 ep-fade-in ep-bg-pattern"
                          style={{
                            padding: '12px 14px',
                            border: '1px solid',
                            borderRadius: 3
                          }}>
                          <div
                            className="ep-h3 ep-c-pattern mb-1"
                            style={{ fontSize: 15, fontStyle: 'italic' }}>
                            {selectedCatalogPattern.name}
                          </div>
                          <div className="flex items-center gap-1.5 flex-wrap mb-2">
                            <span
                              className="ep-pill"
                              style={{
                                background: 'rgba(92,184,144,0.10)',
                                borderColor: 'rgba(92,184,144,0.30)',
                                fontSize: 9.5
                              }}>
                              {TRIGGERS[selectedCatalogPattern.trigger]?.name}
                            </span>
                            <span style={{ color: '#8A8273', fontSize: 11 }}>×</span>
                            <span className="ep-pill ep-pill-verb" style={{ fontSize: 9.5 }}>
                              {VERB_HOMES[selectedCatalogPattern.verb]?.name}
                            </span>
                          </div>
                          <p
                            className="ep-serif"
                            style={{
                              fontSize: 13,
                              lineHeight: 1.5,
                              fontStyle: 'italic',
                              marginBottom: 8
                            }}>
                            {selectedCatalogPattern.desc}
                          </p>
                          <div className="space-y-2">
                            <div>
                              <div className="ep-label mb-1" style={{ fontSize: 9.5 }}>
                                Grammar
                              </div>
                              <div
                                className="ep-mono"
                                style={{
                                  fontSize: 11.5,
                                  lineHeight: 1.55,
                                  color: '#E8E2D2'
                                }}>
                                {selectedCatalogPattern.grammar}
                              </div>
                            </div>
                            {selectedCatalogPattern.entities?.length > 0 && (
                              <div>
                                <div className="ep-label mb-1" style={{ fontSize: 9.5 }}>
                                  Typical entities
                                </div>
                                <div className="flex flex-wrap gap-1">
                                  {selectedCatalogPattern.entities.map((e, i) => (
                                    <span
                                      key={i}
                                      className="ep-pill ep-pill-entity"
                                      style={{ fontSize: 9.5 }}>
                                      {e}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}
                            <div>
                              <div className="ep-label mb-1" style={{ fontSize: 9.5 }}>
                                Typical actors
                              </div>
                              <div className="flex flex-wrap gap-1">
                                {selectedCatalogPattern.actors.map((a, i) => (
                                  <span
                                    key={i}
                                    className="ep-pill ep-pill-actor"
                                    style={{ fontSize: 9.5 }}>
                                    {ACTOR_ARCHETYPES[a]?.name || a}
                                  </span>
                                ))}
                              </div>
                            </div>
                            {selectedCatalogPattern.touches_verbs?.length > 0 && (
                              <div>
                                <div className="ep-label mb-1" style={{ fontSize: 9.5 }}>
                                  Also touches
                                </div>
                                <div className="flex flex-wrap gap-1">
                                  {selectedCatalogPattern.touches_verbs.map((v, i) => (
                                    <span
                                      key={i}
                                      className="ep-pill ep-pill-verb"
                                      style={{ fontSize: 9.5 }}>
                                      {VERB_HOMES[v]?.name || v}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}
                            <div>
                              <div className="ep-label mb-1" style={{ fontSize: 9.5 }}>
                                Variations
                              </div>
                              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                                {selectedCatalogPattern.variations.map((v, i) => (
                                  <li
                                    key={i}
                                    className="ep-serif ep-muted"
                                    style={{
                                      fontSize: 12,
                                      fontStyle: 'italic',
                                      marginBottom: 2
                                    }}>
                                    · {v}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          </div>
                        </div>
                      )}

                      <div
                        className="mt-4 pt-3"
                        style={{ borderTop: '1px solid rgba(232,226,210,0.10)' }}>
                        <div
                          className="ep-label mb-2"
                          style={{ fontSize: 9.5, opacity: 0.75 }}>
                          Modifiers ({MODIFIERS.length}) — qualify base patterns, not
                          standalone
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {MODIFIERS.map((m) => (
                            <span
                              key={m.id}
                              className="ep-pill"
                              title={m.desc}
                              style={{
                                background: 'rgba(184,90,58,0.08)',
                                borderColor: 'rgba(184,90,58,0.25)',
                                fontSize: 9.5,
                                cursor: 'help'
                              }}>
                              {m.name}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {sidebarTab === 'list' && (
                  <div className="space-y-3">
                    <div style={{ position: 'relative' }}>
                      <Search
                        size={11}
                        style={{
                          position: 'absolute',
                          left: 9,
                          top: '50%',
                          transform: 'translateY(-50%)',
                          color: '#8A8273',
                          pointerEvents: 'none'
                        }}
                      />
                      <input
                        type="text"
                        value={catalogSearch}
                        onChange={(e) => setCatalogSearch(e.target.value)}
                        placeholder="Search entities…"
                        className="ep-input"
                        style={{
                          paddingLeft: 26,
                          paddingRight: catalogSearchActive ? 26 : 10
                        }}
                      />
                      {catalogSearchActive && (
                        <button
                          onClick={() => setCatalogSearch('')}
                          style={{
                            position: 'absolute',
                            right: 6,
                            top: '50%',
                            transform: 'translateY(-50%)',
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            color: '#8A8273',
                            padding: 4,
                            display: 'flex'
                          }}
                          title="Clear">
                          <X size={11} />
                        </button>
                      )}
                    </div>

                    <div
                      className="ep-label flex items-center gap-1.5"
                      style={{ marginTop: 2 }}>
                      <Box size={11} className="ep-c-entity" /> All entities{' '}
                      {catalogSearchActive ? (
                        <span
                          className="ep-muted"
                          style={{ fontSize: 10, fontWeight: 400, letterSpacing: 0 }}>
                          ({filteredCatalogCount} of {ENTITY_CATALOG.length})
                        </span>
                      ) : (
                        <span
                          className="ep-muted"
                          style={{ fontSize: 10, fontWeight: 400, letterSpacing: 0 }}>
                          ({ENTITY_CATALOG.length})
                        </span>
                      )}
                    </div>

                    {filteredCatalogFlat.length === 0 ? (
                      <p
                        className="ep-serif ep-muted"
                        style={{ fontSize: 13, fontStyle: 'italic' }}>
                        No matches.
                      </p>
                    ) : (
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 1,
                          maxHeight: 'calc(100vh - 320px)',
                          overflowY: 'auto',
                          paddingRight: 4
                        }}>
                        {filteredCatalogFlat.map((e) => {
                          const isSelected = selectedCatalogEntity?.name === e.name
                          return (
                            <button
                              key={e.name}
                              onClick={() => {
                                setSelectedCatalogEntity(isSelected ? null : e)
                                setSelectedCatalogPattern(null)
                              }}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 8,
                                padding: '6px 8px',
                                background: isSelected
                                  ? 'rgba(181,172,159,0.08)'
                                  : 'transparent',
                                border: 'none',
                                borderRadius: 2,
                                cursor: 'pointer',
                                textAlign: 'left',
                                width: '100%',
                                transition: 'background 0.08s'
                              }}
                              onMouseEnter={(ev) => {
                                if (!isSelected)
                                  ev.currentTarget.style.background = 'rgba(181,172,159,0.04)'
                              }}
                              onMouseLeave={(ev) => {
                                if (!isSelected)
                                  ev.currentTarget.style.background = 'transparent'
                              }}>
                              <span
                                style={{
                                  display: 'inline-block',
                                  width: 7,
                                  height: 7,
                                  borderRadius: '50%',
                                  background:
                                    { core: '#7AA8C2', domain: '#D17B4A' }[
                                      ENTITY_CATEGORIES[e.category]?.tier
                                    ] || '#8A8273',
                                  flexShrink: 0
                                }}
                              />
                              <span
                                className="ep-mono"
                                style={{
                                  fontSize: 12.5,
                                  color: '#E8E2D2',
                                  fontWeight: 500,
                                  minWidth: 0
                                }}>
                                {e.name}
                              </span>
                              <span
                                className="ep-label"
                                style={{
                                  fontSize: 9,
                                  opacity: 0.55,
                                  marginLeft: 'auto',
                                  flexShrink: 0
                                }}>
                                {e.verb}
                              </span>
                              {e.transitions?.length > 0 && (
                                <span
                                  className="ep-mono"
                                  title={`${e.transitions.length} canonical transitions`}
                                  style={{ fontSize: 9, color: '#8A8273', flexShrink: 0 }}>
                                  {e.transitions.length}↻
                                </span>
                              )}
                            </button>
                          )
                        })}
                      </div>
                    )}

                    {selectedCatalogEntity && (
                      <div
                        className="mt-3 ep-fade-in ep-bg-entity"
                        style={{
                          padding: '12px 14px',
                          border: '1px solid',
                          borderRadius: 3
                        }}>
                        <div className="ep-mono ep-h3 mb-1" style={{ fontSize: 15 }}>
                          {selectedCatalogEntity.name}
                        </div>
                        <div className="flex items-center gap-1.5 mb-2 flex-wrap">
                          <span
                            style={{
                              display: 'inline-block',
                              width: 7,
                              height: 7,
                              borderRadius: '50%',
                              background:
                                { core: '#7AA8C2', domain: '#D17B4A' }[
                                  ENTITY_CATEGORIES[selectedCatalogEntity.category]?.tier
                                ] || '#8A8273'
                            }}
                          />
                          <span className="ep-label" style={{ fontSize: 9.5 }}>
                            {VERB_HOMES[selectedCatalogEntity.verb]?.name}
                          </span>
                        </div>
                        <p
                          className="ep-serif"
                          style={{
                            fontSize: 13,
                            lineHeight: 1.5,
                            fontStyle: 'italic',
                            marginBottom: 8
                          }}>
                          {selectedCatalogEntity.desc}
                        </p>
                        <div className="space-y-2">
                          <div>
                            <div className="ep-label mb-1" style={{ fontSize: 9.5 }}>
                              Touches
                            </div>
                            <div className="flex flex-wrap gap-1">
                              {selectedCatalogEntity.touches.map((v, i) => (
                                <span
                                  key={i}
                                  className="ep-pill ep-pill-verb"
                                  style={{ fontSize: 9.5 }}>
                                  {VERB_HOMES[v]?.name || v}
                                </span>
                              ))}
                            </div>
                          </div>
                          <div>
                            <div className="ep-label mb-1" style={{ fontSize: 9.5 }}>
                              Typical actors
                            </div>
                            <div className="flex flex-wrap gap-1">
                              {selectedCatalogEntity.actors.map((a, i) => (
                                <span
                                  key={i}
                                  className="ep-pill ep-pill-actor"
                                  style={{ fontSize: 9.5 }}>
                                  {ACTOR_ARCHETYPES[a]?.name || a}
                                </span>
                              ))}
                            </div>
                          </div>
                          <div>
                            <div className="ep-label mb-1" style={{ fontSize: 9.5 }}>
                              Typical patterns
                            </div>
                            <div className="flex flex-wrap gap-1">
                              {selectedCatalogEntity.patterns.map((p, i) => {
                                const pat = PATTERN_CATALOG.find((x) => x.id === p)
                                return (
                                  <span
                                    key={i}
                                    className="ep-pill ep-pill-pattern"
                                    style={{ fontSize: 9.5 }}>
                                    {pat?.name || p}
                                  </span>
                                )
                              })}
                            </div>
                          </div>
                          {selectedCatalogEntity.kinds?.length > 0 && (
                            <div>
                              <div className="ep-label mb-1" style={{ fontSize: 9.5 }}>
                                Catalog-blessed kinds ({selectedCatalogEntity.kinds.length})
                              </div>
                              <div className="flex flex-wrap gap-1">
                                {selectedCatalogEntity.kinds.map((k, i) => (
                                  <span
                                    key={i}
                                    className="ep-pill ep-mono"
                                    style={{
                                      fontSize: 9.5,
                                      background: 'rgba(181,172,159,0.06)'
                                    }}>
                                    {selectedCatalogEntity.name}:{k}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                          {selectedCatalogEntity.transitions?.length > 0 && (
                            <div>
                              <div className="ep-label mb-1" style={{ fontSize: 9.5 }}>
                                Canonical transitions (
                                {selectedCatalogEntity.transitions.length})
                              </div>
                              <div
                                style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                {selectedCatalogEntity.transitions.map((t, i) => (
                                  <div
                                    key={i}
                                    style={{
                                      fontFamily: 'JetBrains Mono, monospace',
                                      fontSize: 10.5,
                                      lineHeight: 1.4,
                                      display: 'flex',
                                      alignItems: 'center',
                                      flexWrap: 'wrap',
                                      gap: 4
                                    }}>
                                    <span style={{ color: '#B5AC9F' }}>{t.from}</span>
                                    <span style={{ color: '#8A8273' }}>→</span>
                                    <span style={{ color: '#E8E2D2', fontWeight: 500 }}>
                                      {t.to}
                                    </span>
                                    <span
                                      className="ep-serif ep-muted"
                                      style={{
                                        fontStyle: 'italic',
                                        fontSize: 10.5,
                                        marginLeft: 4
                                      }}>
                                      {t.trigger}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          <div>
                            <div className="ep-label mb-1" style={{ fontSize: 9.5 }}>
                              Example
                            </div>
                            <p
                              className="ep-serif ep-muted"
                              style={{ fontSize: 12, fontStyle: 'italic' }}>
                              {selectedCatalogEntity.example}
                            </p>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </aside>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function GrammarText({ children, block = false, style = {} }) {
  const text = typeof children === 'string' ? children : ''
  if (!text) return null

  // Token order matters; longer / more specific patterns first.
  // Verb group (6) is last — structural tokens start with [ { + ( → and never
  // collide with verbs (letters). \b guards partial matches; 'i' flag handles
  // sentence/line-initial capitalization. Verbs inside [brackets] are consumed
  // by the entity group first, so they never match as verbs.
  const TOKEN_RE = new RegExp(
    '(\\[[^\\]]+\\])|(\\{[^}]+\\})|(\\+[A-Za-z][a-zA-Z]*)|(\\((?:user|time|state|external) trigger\\))|(→)|\\b(' +
      VERB_ALTERNATION +
      ')\\b',
    'gi'
  )
  const tokens = []
  let lastIdx = 0
  let m
  while ((m = TOKEN_RE.exec(text)) !== null) {
    if (m.index > lastIdx) tokens.push({ k: 'text', v: text.slice(lastIdx, m.index) })
    if (m[1]) tokens.push({ k: 'entity', v: m[1] })
    else if (m[2]) tokens.push({ k: 'pattern', v: m[2] })
    else if (m[3]) tokens.push({ k: 'mod', v: m[3] })
    else if (m[4]) tokens.push({ k: 'trigger', v: m[4] })
    else if (m[5]) tokens.push({ k: 'arrow', v: m[5] })
    else if (m[6])
      tokens.push({ k: 'verb', v: m[6], sig: VERB_FORM_LOOKUP[m[6].toLowerCase()] })
    lastIdx = TOKEN_RE.lastIndex
  }
  if (lastIdx < text.length) tokens.push({ k: 'text', v: text.slice(lastIdx) })

  const TRIGGER_TONE = {
    user: '#7AA8C2',
    time: '#A292C0',
    state: '#B85A3A',
    external: '#C19C84'
  }

  const renderToken = (t, i) => {
    if (t.k === 'text') return <span key={i}>{t.v}</span>
    if (t.k === 'entity') {
      // Optionally split out :kind for subtle two-tone treatment
      const inner = t.v.slice(1, -1)
      const colonIdx = inner.indexOf(':')
      const base = colonIdx >= 0 ? inner.slice(0, colonIdx) : inner
      const kind = colonIdx >= 0 ? inner.slice(colonIdx) : ''
      return (
        <span key={i} style={{ color: '#5CB890', fontWeight: 600 }}>
          [<span>{base}</span>
          {kind && <span style={{ color: '#92BD80', fontWeight: 500 }}>{kind}</span>}]
        </span>
      )
    }
    if (t.k === 'pattern')
      return (
        <span key={i} style={{ color: '#B85A3A', fontWeight: 600, fontStyle: 'italic' }}>
          {t.v}
        </span>
      )
    if (t.k === 'mod')
      return (
        <span key={i} style={{ color: '#D17B4A', fontWeight: 600 }}>
          {t.v}
        </span>
      )
    if (t.k === 'trigger') {
      const inner = t.v.slice(1, -1)
      const word = inner.split(' ')[0]
      const tone = TRIGGER_TONE[word] || '#8A8273'
      return (
        <span
          key={i}
          style={{ color: tone, fontStyle: 'italic', opacity: 0.85, fontSize: '0.92em' }}>
          {t.v}
        </span>
      )
    }
    if (t.k === 'verb') {
      const sig = t.sig
      if (!sig) return <span key={i}>{t.v}</span>
      const isInternalRead = sig.boundary === 'internal' && sig.persistence === 'reads'
      // Internal read recedes fully: dim, normal weight, no dot, no glyph.
      if (isInternalRead) {
        return (
          <span key={i} style={{ color: '#8A8273', fontWeight: 400 }}>
            {t.v}
          </span>
        )
      }
      const bStyle = VERB_BOUNDARY_STYLE[sig.boundary] || VERB_BOUNDARY_STYLE.internal
      const mutates = sig.persistence === 'mutates'
      const dot = mutates ? '●' : '○'
      return (
        <span
          key={i}
          style={{
            color: bStyle.color,
            fontWeight: mutates ? 500 : 400,
            whiteSpace: 'nowrap'
          }}>
          <span
            style={{
              fontSize: '0.62em',
              verticalAlign: '0.12em',
              opacity: 0.85,
              marginRight: 2
            }}>
            {dot}
          </span>
          {bStyle.glyph && (
            <span style={{ marginRight: 1, fontSize: '0.9em' }}>{bStyle.glyph}</span>
          )}
          {t.v}
        </span>
      )
    }
    if (t.k === 'arrow')
      return (
        <span key={i} style={{ color: '#8A8273', margin: '0 1px' }}>
          {t.v}
        </span>
      )
    return null
  }

  const Tag = block ? 'pre' : 'div'
  return (
    <Tag
      className="ep-grammar"
      style={{
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontFamily: 'JetBrains Mono, monospace',
        margin: 0,
        ...style
      }}>
      {tokens.map(renderToken)}
    </Tag>
  )
}

function Section({ label, children }) {
  return (
    <div
      className="mb-4 pb-3"
      style={{ borderTop: '1px solid rgba(232,226,210,0.1)', paddingTop: 12 }}>
      <div className="ep-label mb-2">{label}</div>
      {children}
    </div>
  )
}

// ── DAG visualization of a system-mode result ─────────────────────────────
// Treats `patterns` as nodes and `interactions` as edges. Patterns with the
// same id collapse into a single node (so two `notification` patterns appear
// once). Layout is column-by-depth, with within-column ordering nudged toward
// each node's source y to reduce crossings.
const SYSTEM_DAG_TRIGGER_COLORS = {
  time: '#D49852',
  state: '#3FA77F',
  user: '#9582C0',
  external: '#7AA8C2'
}

function computeSystemDAGLayout(patterns, interactions) {
  if (!patterns || patterns.length === 0) return null

  // Dedupe by id (first occurrence wins). The trade-off is that repeated ids
  // collapse — acceptable for v1; most decompositions don't repeat pattern ids.
  const byId = {}
  const nodes = []
  patterns.forEach((p, idx) => {
    if (!p.id || byId[p.id]) return
    const node = {
      key: p.id,
      id: p.id,
      idx,
      name: p.name || p.id,
      trigger: p.trigger,
      verb: p.verb,
      modifiers: p.modifiers || []
    }
    byId[p.id] = node
    nodes.push(node)
  })
  if (nodes.length === 0) return null

  const incoming = {}
  const outgoing = {}
  nodes.forEach((n) => {
    incoming[n.id] = []
    outgoing[n.id] = []
  })
  ;(interactions || []).forEach((it) => {
    if (!byId[it.from] || !byId[it.to]) return
    if (it.from === it.to) return // skip self-loops
    if (!incoming[it.to].includes(it.from)) incoming[it.to].push(it.from)
    if (!outgoing[it.from].includes(it.to)) outgoing[it.from].push(it.to)
  })

  // Depth via relaxation (handles arbitrary DAG shape including diamonds)
  const depth = {}
  nodes.forEach((n) => {
    if (incoming[n.id].length === 0) depth[n.id] = 0
  })
  for (let iter = 0; iter < nodes.length + 2; iter++) {
    let changed = false
    nodes.forEach((n) => {
      const sources = incoming[n.id]
      if (sources.length === 0) return
      const sourceDepths = sources.map((s) => depth[s]).filter((d) => d !== undefined)
      if (sourceDepths.length === 0) return
      const newDepth = Math.max.apply(null, sourceDepths) + 1
      if (depth[n.id] === undefined || newDepth > depth[n.id]) {
        depth[n.id] = newDepth
        changed = true
      }
    })
    if (!changed) break
  }
  nodes.forEach((n) => {
    if (depth[n.id] === undefined) depth[n.id] = 0
  })

  const maxDepth = Math.max.apply(null, Object.values(depth))
  const cols = Array.from({ length: maxDepth + 1 }, () => [])
  nodes.forEach((n) => cols[depth[n.id]].push(n))

  // Layout constants
  const boxWidth = 150
  const boxHeight = 56
  const colSpacing = 210 // x distance between column centers
  const rowSpacing = 92 // y distance between rows in a column
  const padX = 24
  const padY = 18

  const maxColSize = Math.max.apply(
    null,
    cols.map((c) => c.length)
  )
  const totalWidth = padX * 2 + boxWidth + colSpacing * maxDepth
  const totalHeight = padY * 2 + boxHeight + rowSpacing * (maxColSize - 1)

  // Initial placement: center each column vertically
  const place = () => {
    cols.forEach((col, colIdx) => {
      const cx = padX + boxWidth / 2 + colIdx * colSpacing
      const groupHeight = (col.length - 1) * rowSpacing + boxHeight
      const startY = (totalHeight - groupHeight) / 2 + boxHeight / 2
      col.forEach((node, i) => {
        node.x = cx
        node.y = startY + i * rowSpacing
      })
    })
  }
  place()

  // Reorder non-root columns by avg incoming-source y, then re-place
  // (one pass is enough for typical small DAGs)
  cols.forEach((col, colIdx) => {
    if (colIdx === 0 || col.length <= 1) return
    col.sort((a, b) => {
      const aSrcs = incoming[a.id] || []
      const bSrcs = incoming[b.id] || []
      const aY = aSrcs.length
        ? aSrcs.map((s) => byId[s].y).reduce((s, v) => s + v, 0) / aSrcs.length
        : a.y
      const bY = bSrcs.length
        ? bSrcs.map((s) => byId[s].y).reduce((s, v) => s + v, 0) / bSrcs.length
        : b.y
      return aY - bY
    })
  })
  place()

  // Build edges with positions (anchor to right/left edges of boxes)
  const edges = []
  ;(interactions || []).forEach((it) => {
    const a = byId[it.from]
    const b = byId[it.to]
    if (!a || !b || a === b) return
    edges.push({
      fromKey: a.key,
      toKey: b.key,
      via: it.via,
      kind: it.kind,
      fromX: a.x + boxWidth / 2,
      fromY: a.y,
      toX: b.x - boxWidth / 2,
      toY: b.y
    })
  })

  return { nodes, edges, width: totalWidth, height: totalHeight, boxWidth, boxHeight }
}

function SystemPatternDAG({ result }) {
  const [hovered, setHovered] = useState(null)
  const layout = useMemo(
    () => computeSystemDAGLayout(result?.patterns, result?.interactions),
    [result]
  )
  if (!layout) return null
  const { nodes, edges, width, height, boxWidth, boxHeight } = layout

  // For label-on-edge placement: midpoint, nudged perpendicular to the line direction
  const edgeLabel = (e) => {
    const mx = (e.fromX + e.toX) / 2
    const my = (e.fromY + e.toY) / 2
    // Nudge above the line; for purely horizontal edges this puts label cleanly above.
    return { x: mx, y: my - 6 }
  }

  return (
    <Section label="Pattern interactions · system shape">
      <div
        style={{
          background: 'rgba(232,226,210,0.025)',
          border: '1px solid rgba(232,226,210,0.06)',
          borderRadius: 3,
          padding: '10px 6px'
        }}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          style={{ width: '100%', height: 'auto', display: 'block' }}>
          <defs>
            <marker
              id="dag-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse">
              <path
                d="M2 1L8 5L2 9"
                fill="none"
                stroke="rgba(232,226,210,0.55)"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </marker>
          </defs>

          {/* Edges first (under nodes) */}
          {edges.map((e, i) => {
            const dimmed = hovered && hovered !== e.fromKey && hovered !== e.toKey
            const lbl = edgeLabel(e)
            return (
              <g
                key={`e${i}`}
                opacity={dimmed ? 0.12 : 1}
                style={{ transition: 'opacity 150ms' }}>
                <line
                  x1={e.fromX}
                  y1={e.fromY}
                  x2={e.toX}
                  y2={e.toY}
                  stroke="rgba(232,226,210,0.45)"
                  strokeWidth="0.6"
                  markerEnd="url(#dag-arrow)"
                  fill="none"
                />
                {e.via && (
                  <text
                    x={lbl.x}
                    y={lbl.y}
                    textAnchor="middle"
                    fontSize="9.5"
                    fontFamily="JetBrains Mono, monospace"
                    fill="rgba(232,226,210,0.45)"
                    style={{ pointerEvents: 'none' }}>
                    via {e.via}
                  </text>
                )}
              </g>
            )
          })}

          {/* Nodes */}
          {nodes.map((n) => {
            const dimmed = hovered && hovered !== n.key
            const color = SYSTEM_DAG_TRIGGER_COLORS[n.trigger] || '#8A8273'
            const modifierStr = (n.modifiers || [])
              .map((m) => m.id)
              .filter(Boolean)
              .join(' · ')
            return (
              <g
                key={n.key}
                transform={`translate(${n.x - boxWidth / 2}, ${n.y - boxHeight / 2})`}
                opacity={dimmed ? 0.32 : 1}
                onMouseEnter={() => setHovered(n.key)}
                onMouseLeave={() => setHovered(null)}
                style={{ cursor: 'default', transition: 'opacity 150ms' }}>
                <rect
                  width={boxWidth}
                  height={boxHeight}
                  rx="5"
                  fill={`${color}26`}
                  stroke={color}
                  strokeWidth="0.6"
                />
                <text
                  x={boxWidth / 2}
                  y={22}
                  textAnchor="middle"
                  fontSize="12.5"
                  fontFamily="JetBrains Mono, monospace"
                  fill="#E8E2D2"
                  fontWeight="500">
                  {n.name && n.name.length > 18 ? n.name.slice(0, 17) + '…' : n.name}
                </text>
                <text
                  x={boxWidth / 2}
                  y={40}
                  textAnchor="middle"
                  fontSize="9"
                  fontFamily="JetBrains Mono, monospace"
                  fill={color}
                  opacity="0.95">
                  {n.trigger || '?'} × {n.verb || '?'}
                  {modifierStr ? ` · ${modifierStr}` : ''}
                </text>
              </g>
            )
          })}
        </svg>

        {/* Legend */}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 10,
            padding: '8px 8px 2px',
            fontSize: 9,
            fontFamily: 'JetBrains Mono, monospace',
            color: 'rgba(232,226,210,0.55)',
            letterSpacing: '0.06em'
          }}>
          {Object.entries(SYSTEM_DAG_TRIGGER_COLORS).map(([trig, col]) => (
            <span key={trig} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span
                style={{
                  display: 'inline-block',
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: col
                }}
              />
              {trig}
            </span>
          ))}
        </div>
      </div>
    </Section>
  )
}

function GraphView({ onBack, sessionEntities = [], sessionPatterns = [] }) {
  const svgRef = useRef(null)
  const [selectedEntity, setSelectedEntity] = useState(null)
  const [graphMode, setGraphMode] = useState('catalog')
  const width = 1200
  const height = 750

  useEffect(() => {
    if (graphMode !== 'catalog') return
    if (!svgRef.current) return

    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()

    const nodes = ENTITY_CATALOG.map((e) => ({ ...e, id: e.name }))

    const linkSet = new Set()
    const links = []
    ENTITY_CATALOG.forEach((e) => {
      e.neighbors.forEach((n) => {
        if (ENTITY_CATALOG_NAMES.has(n)) {
          const key = [e.name, n].sort().join('|')
          if (!linkSet.has(key)) {
            linkSet.add(key)
            links.push({ source: e.name, target: n })
          }
        }
      })
    })

    // 10 category clusters laid out as 4+3 Core rows on top, 3 Domain across the bottom.
    // Position encodes category; node color encodes tier (Core vs Domain).
    const clusterCenters = {
      // Core — top half
      identity_access: { x: width * 0.13, y: height * 0.16 },
      capture: { x: width * 0.37, y: height * 0.16 },
      communication: { x: width * 0.62, y: height * 0.16 },
      integration: { x: width * 0.86, y: height * 0.16 },
      read_surfaces: { x: width * 0.22, y: height * 0.44 },
      operations: { x: width * 0.5, y: height * 0.44 },
      meta: { x: width * 0.78, y: height * 0.44 },
      // Domain — bottom row
      service_scheduling: { x: width * 0.22, y: height * 0.78 },
      commerce_value: { x: width * 0.5, y: height * 0.78 },
      content_public: { x: width * 0.78, y: height * 0.78 }
    }

    const TIER_COLORS = { core: '#7AA8C2', domain: '#D17B4A' }
    const tierOf = (cat) => ENTITY_CATEGORIES[cat]?.tier
    const colorOf = (cat) => TIER_COLORS[tierOf(cat)] || '#8A8273'

    const simulation = d3
      .forceSimulation(nodes)
      .force(
        'link',
        d3
          .forceLink(links)
          .id((d) => d.id)
          .distance(70)
          .strength(0.35)
      )
      .force('charge', d3.forceManyBody().strength(-240))
      .force('collision', d3.forceCollide(42))
      .force('cluster', () => {
        const alpha = 0.13
        nodes.forEach((node) => {
          const center = clusterCenters[node.category]
          if (!center) return
          node.vx += (center.x - node.x) * alpha
          node.vy += (center.y - node.y) * alpha
        })
      })

    // Cluster background labels — category name, tier-colored, faint
    const labelGroup = svg.append('g').attr('class', 'cluster-labels')
    Object.entries(clusterCenters).forEach(([catKey, center]) => {
      const catMeta = ENTITY_CATEGORIES[catKey]
      labelGroup
        .append('text')
        .attr('x', center.x)
        .attr('y', center.y - 78)
        .attr('text-anchor', 'middle')
        .attr('font-family', 'JetBrains Mono, monospace')
        .attr('font-size', 9.5)
        .attr('letter-spacing', '0.14em')
        .attr('text-transform', 'uppercase')
        .attr('fill', TIER_COLORS[catMeta?.tier] || '#8A8273')
        .attr('opacity', 0.5)
        .text((catMeta?.name || catKey).toUpperCase())
    })

    const linkGroup = svg.append('g').attr('class', 'links')
    const link = linkGroup
      .selectAll('line')
      .data(links)
      .join('line')
      .attr('stroke', 'rgba(232,226,210,0.2)')
      .attr('stroke-width', 1)

    const nodeGroup = svg.append('g').attr('class', 'nodes')
    const node = nodeGroup
      .selectAll('g')
      .data(nodes)
      .join('g')
      .attr('cursor', 'pointer')
      .call(
        d3
          .drag()
          .on('start', (event, d) => {
            if (!event.active) simulation.alphaTarget(0.3).restart()
            d.fx = d.x
            d.fy = d.y
          })
          .on('drag', (event, d) => {
            d.fx = event.x
            d.fy = event.y
          })
          .on('end', (event, d) => {
            if (!event.active) simulation.alphaTarget(0)
            d.fx = null
            d.fy = null
          })
      )

    node
      .append('circle')
      .attr('r', 9)
      .attr('fill', (d) => colorOf(d.category))
      .attr('stroke', '#1E1B15')
      .attr('stroke-width', 1.5)

    node
      .append('text')
      .text((d) => d.id)
      .attr('x', 14)
      .attr('y', 4)
      .attr('font-family', 'JetBrains Mono, monospace')
      .attr('font-size', 11)
      .attr('font-weight', 500)
      .attr('fill', '#E8E2D2')
      .attr('pointer-events', 'none')
      .attr('paint-order', 'stroke')
      .attr('stroke', '#15130F')
      .attr('stroke-width', 3)
      .attr('stroke-linejoin', 'round')

    node.on('mouseenter', function (event, d) {
      const connectedIds = new Set([d.id])
      links.forEach((l) => {
        if (l.source.id === d.id) connectedIds.add(l.target.id)
        if (l.target.id === d.id) connectedIds.add(l.source.id)
      })
      node
        .transition()
        .duration(150)
        .style('opacity', (n) => (connectedIds.has(n.id) ? 1 : 0.18))
      link
        .transition()
        .duration(150)
        .attr('stroke', (l) =>
          l.source.id === d.id || l.target.id === d.id ? '#B85A3A' : 'rgba(232,226,210,0.06)'
        )
        .attr('stroke-width', (l) => (l.source.id === d.id || l.target.id === d.id ? 1.8 : 1))
    })

    node.on('mouseleave', function () {
      node.transition().duration(180).style('opacity', 1)
      link
        .transition()
        .duration(180)
        .attr('stroke', 'rgba(232,226,210,0.2)')
        .attr('stroke-width', 1)
    })

    node.on('click', (event, d) => {
      const full = ENTITY_CATALOG.find((e) => e.name === d.id)
      setSelectedEntity(full)
    })

    simulation.on('tick', () => {
      link
        .attr('x1', (d) => d.source.x)
        .attr('y1', (d) => d.source.y)
        .attr('x2', (d) => d.target.x)
        .attr('y2', (d) => d.target.y)
      node.attr('transform', (d) => `translate(${d.x},${d.y})`)
    })

    return () => simulation.stop()
  }, [graphMode])

  return (
    <div
      className="ep-app"
      style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <header
        style={{
          padding: '14px 24px',
          borderBottom: '1px solid rgba(232,226,210,0.14)',
          background: '#15130F'
        }}>
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-4">
            <button onClick={onBack} className="ep-btn ep-btn-ghost ep-btn-sm">
              <ArrowLeft size={11} /> Back
            </button>
            <div>
              <div className="ep-label">
                {graphMode === 'catalog'
                  ? 'Entity catalog · graph view'
                  : 'Your session · system map'}
              </div>
              <div
                className="ep-h2"
                style={{ fontSize: 22, fontStyle: 'italic', marginTop: 2 }}>
                {graphMode === 'catalog' ? 'The map' : 'Your system'}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <div className="ep-mode-toggle">
              <button
                onClick={() => setGraphMode('catalog')}
                className={`ep-mode-btn entity ${graphMode === 'catalog' ? 'active' : ''}`}
                style={{ fontSize: 11 }}>
                <Network size={11} /> Catalog
              </button>
              <button
                onClick={() => setGraphMode('session')}
                className={`ep-mode-btn pattern ${graphMode === 'session' ? 'active' : ''}`}
                style={{ fontSize: 11 }}>
                <Layers size={11} /> Session
              </button>
            </div>
            {graphMode === 'catalog' && (
              <div className="flex flex-wrap gap-1.5">
                {[
                  { key: 'core', label: 'Core · universal', color: '#7AA8C2' },
                  { key: 'domain', label: 'Domain · contextual', color: '#D17B4A' }
                ].map((t) => (
                  <span
                    key={t.key}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      padding: '3px 9px',
                      border: `1px solid ${t.color}`,
                      background: 'transparent',
                      color: t.color,
                      fontFamily: 'JetBrains Mono, monospace',
                      fontSize: 10,
                      letterSpacing: '0.04em',
                      borderRadius: 2
                    }}>
                    <span
                      style={{
                        display: 'inline-block',
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        background: t.color
                      }}
                    />
                    {t.label}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </header>

      {graphMode === 'session' ? (
        <SessionMap sessionEntities={sessionEntities} sessionPatterns={sessionPatterns} />
      ) : (
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div
            style={{
              flex: 1,
              position: 'relative',
              background: '#15130F',
              backgroundImage: 'radial-gradient(rgba(232,226,210,0.04) 1px, transparent 1px)',
              backgroundSize: '24px 24px'
            }}>
            <svg
              ref={svgRef}
              width="100%"
              height="100%"
              viewBox={`0 0 ${width} ${height}`}
              preserveAspectRatio="xMidYMid meet"
              style={{ display: 'block', minHeight: 600 }}
            />
          </div>

          {selectedEntity && (
            <aside
              style={{
                width: 340,
                borderLeft: '1px solid rgba(232,226,210,0.14)',
                padding: 20,
                background: '#1E1B15',
                overflowY: 'auto',
                maxHeight: 'calc(100vh - 120px)',
                flexShrink: 0
              }}>
              <div className="flex items-start justify-between mb-3">
                <div className="flex-1 min-w-0">
                  <div className="ep-label mb-1">Inspecting</div>
                  <div
                    className="ep-mono ep-h2"
                    style={{ fontSize: 22, wordBreak: 'break-word' }}>
                    {selectedEntity.name}
                  </div>
                </div>
                <button
                  onClick={() => setSelectedEntity(null)}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: '#8A8273',
                    padding: 0,
                    marginTop: 4
                  }}>
                  <X size={14} />
                </button>
              </div>

              <div className="mb-3">
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    padding: '3px 9px',
                    border: `1px solid ${
                      { core: '#7AA8C2', domain: '#D17B4A' }[
                        ENTITY_CATEGORIES[selectedEntity.category]?.tier
                      ] || '#8A8273'
                    }`,
                    color:
                      { core: '#7AA8C2', domain: '#D17B4A' }[
                        ENTITY_CATEGORIES[selectedEntity.category]?.tier
                      ] || '#8A8273',
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 10,
                    borderRadius: 2,
                    background: `${
                      { core: '#7AA8C2', domain: '#D17B4A' }[
                        ENTITY_CATEGORIES[selectedEntity.category]?.tier
                      ] || '#8A8273'
                    }10`
                  }}>
                  <span
                    style={{
                      display: 'inline-block',
                      width: 7,
                      height: 7,
                      borderRadius: '50%',
                      background:
                        { core: '#7AA8C2', domain: '#D17B4A' }[
                          ENTITY_CATEGORIES[selectedEntity.category]?.tier
                        ] || '#8A8273'
                    }}
                  />
                  {VERB_HOMES[selectedEntity.verb]?.name} · home
                </span>
              </div>

              <p
                className="ep-serif"
                style={{
                  fontSize: 14,
                  lineHeight: 1.55,
                  fontStyle: 'italic',
                  marginBottom: 16
                }}>
                {selectedEntity.desc}
              </p>

              {selectedEntity.touches?.length > 0 && (
                <div className="mb-3">
                  <div className="ep-label mb-1.5">Also touches</div>
                  <div className="flex flex-wrap gap-1">
                    {selectedEntity.touches.map((v, i) => (
                      <span
                        key={i}
                        className="ep-pill ep-pill-verb"
                        style={{ fontSize: 9.5 }}>
                        {VERB_HOMES[v]?.name || v}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {selectedEntity.actors?.length > 0 && (
                <div className="mb-3">
                  <div className="ep-label mb-1.5">Actor roles</div>
                  <div className="flex flex-wrap gap-1">
                    {selectedEntity.actors.map((a, i) => (
                      <span
                        key={i}
                        className="ep-pill ep-pill-actor"
                        style={{ fontSize: 9.5 }}>
                        {ACTOR_ARCHETYPES[a]?.name || a}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {selectedEntity.constraints?.length > 0 && (
                <div className="mb-3">
                  <div className="ep-label mb-1.5">Constraints</div>
                  <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                    {selectedEntity.constraints.map((c, i) => (
                      <li
                        key={i}
                        className="ep-serif ep-c-constraint"
                        style={{
                          fontSize: 12.5,
                          fontStyle: 'italic',
                          marginBottom: 3,
                          paddingLeft: 12,
                          position: 'relative'
                        }}>
                        <span style={{ position: 'absolute', left: 0 }}>!</span>
                        {c}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {selectedEntity.patterns?.length > 0 && (
                <div className="mb-3">
                  <div className="ep-label mb-1.5">Typical patterns</div>
                  <div className="flex flex-wrap gap-1">
                    {selectedEntity.patterns.map((p, i) => {
                      const pat = PATTERN_CATALOG.find((x) => x.id === p)
                      return (
                        <span
                          key={i}
                          className="ep-pill ep-pill-pattern"
                          style={{ fontSize: 9.5 }}>
                          {pat?.name || p}
                        </span>
                      )
                    })}
                  </div>
                </div>
              )}

              {selectedEntity.neighbors?.length > 0 && (
                <div className="mb-3">
                  <div className="ep-label mb-1.5">Neighbors (click to navigate)</div>
                  <div className="flex flex-wrap gap-1">
                    {selectedEntity.neighbors.map((n, i) => {
                      const isAvailable = ENTITY_CATALOG_NAMES.has(n)
                      return (
                        <button
                          key={i}
                          onClick={() => {
                            if (isAvailable) {
                              const target = ENTITY_CATALOG.find((e) => e.name === n)
                              if (target) setSelectedEntity(target)
                            }
                          }}
                          disabled={!isAvailable}
                          className={
                            isAvailable ? 'ep-pill ep-pill-entity' : 'ep-pill-entity-novel'
                          }
                          style={{
                            fontSize: 9.5,
                            cursor: isAvailable ? 'pointer' : 'default'
                          }}>
                          {n}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              {selectedEntity.example && (
                <div
                  className="mt-3 pt-3"
                  style={{ borderTop: '1px solid rgba(232,226,210,0.12)' }}>
                  <div className="ep-label mb-1">Example</div>
                  <p
                    className="ep-serif ep-muted"
                    style={{ fontSize: 12.5, fontStyle: 'italic' }}>
                    {selectedEntity.example}
                  </p>
                </div>
              )}
            </aside>
          )}
        </div>
      )}

      <footer
        style={{
          padding: '10px 24px',
          borderTop: '1px solid rgba(232,226,210,0.14)',
          background: '#15130F'
        }}>
        <span className="ep-muted ep-serif" style={{ fontSize: 12, fontStyle: 'italic' }}>
          {graphMode === 'catalog'
            ? 'Click any node to inspect · drag to reposition · hover to highlight connections · clusters group by verb home'
            : 'Filled cells show patterns you\u2019ve accepted this session · shared entities reveal the connective tissue · empty cells hint at what\u2019s missing'}
        </span>
      </footer>
    </div>
  )
}

function SessionMap({ sessionEntities, sessionPatterns }) {
  // Group accepted patterns by (trigger, verb) cell
  const cellMap = useMemo(() => {
    const m = {}
    sessionPatterns.forEach((p) => {
      const canon = PATTERN_CATALOG.find((x) => x.id === p.patternId)
      if (!canon) return
      const key = `${canon.trigger}|${canon.verb}`
      if (!m[key]) m[key] = []
      m[key].push({ ...p, canonName: canon.name })
    })
    return m
  }, [sessionPatterns])

  // Count entity occurrences across accepted patterns
  const entityUsage = useMemo(() => {
    const usage = {}
    sessionPatterns.forEach((p) => {
      ;(p.entitiesInvolved || []).forEach((e) => {
        if (!usage[e]) usage[e] = { patterns: new Set(), count: 0 }
        usage[e].patterns.add(p.canonicalName)
        usage[e].count += 1
      })
    })
    return usage
  }, [sessionPatterns])

  const sharedEntities = useMemo(
    () =>
      Object.entries(entityUsage)
        .filter(([_, v]) => v.patterns.size >= 2)
        .sort((a, b) => b[1].patterns.size - a[1].patterns.size),
    [entityUsage]
  )

  const triggerKeys = ['user', 'time', 'state', 'external']
  const verbKeys = ['capture', 'communicate', 'transform', 'surface', 'other']

  if (sessionPatterns.length === 0 && sessionEntities.length === 0) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#15130F',
          padding: 40
        }}>
        <div style={{ textAlign: 'center', maxWidth: 480 }}>
          <Layers size={32} style={{ color: '#B85A3A', opacity: 0.5, marginBottom: 12 }} />
          <div
            className="ep-h2"
            style={{ fontSize: 24, fontStyle: 'italic', marginBottom: 8 }}>
            Nothing accepted yet
          </div>
          <p
            className="ep-serif ep-muted"
            style={{ fontSize: 14, fontStyle: 'italic', lineHeight: 1.5 }}>
            Recognize patterns or systems and accept them to your session. They'll appear here
            as cells in the trigger × verb grid, with shared entities surfaced below.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div
      style={{
        flex: 1,
        overflowY: 'auto',
        background: '#15130F',
        backgroundImage: 'radial-gradient(rgba(232,226,210,0.04) 1px, transparent 1px)',
        backgroundSize: '24px 24px',
        padding: '24px 24px 40px'
      }}>
      <div style={{ maxWidth: 1200, margin: '0 auto' }}>
        {/* Stats bar */}
        <div className="flex items-center gap-4 mb-5 flex-wrap">
          <div>
            <div className="ep-label" style={{ fontSize: 9.5 }}>
              Patterns
            </div>
            <div className="ep-h2 ep-c-pattern" style={{ fontSize: 28, fontStyle: 'italic' }}>
              {sessionPatterns.length}
            </div>
          </div>
          <div>
            <div className="ep-label" style={{ fontSize: 9.5 }}>
              Entities
            </div>
            <div className="ep-h2 ep-c-entity" style={{ fontSize: 28, fontStyle: 'italic' }}>
              {sessionEntities.length}
            </div>
          </div>
          <div>
            <div className="ep-label" style={{ fontSize: 9.5 }}>
              Shared entities
            </div>
            <div
              className="ep-h2"
              style={{ fontSize: 28, fontStyle: 'italic', color: '#B85A3A' }}>
              {sharedEntities.length}
            </div>
          </div>
          <div>
            <div className="ep-label" style={{ fontSize: 9.5 }}>
              Cells covered
            </div>
            <div
              className="ep-h2"
              style={{ fontSize: 28, fontStyle: 'italic', color: '#5CB890' }}>
              {Object.keys(cellMap).length} / 28
            </div>
          </div>
        </div>

        {/* Grid */}
        <div className="ep-label mb-2" style={{ fontSize: 9.5 }}>
          Pattern grid · trigger × verb
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '80px repeat(7, 1fr)',
            gap: 4,
            marginBottom: 28
          }}>
          {/* header row */}
          <div></div>
          {verbKeys.map((v) => (
            <div
              key={v}
              className="ep-label"
              style={{
                fontSize: 9,
                textAlign: 'center',
                padding: '4px 2px',
                color: VERB_COLORS[v]
              }}>
              {VERB_HOMES[v]?.name || v}
            </div>
          ))}

          {/* body rows */}
          {triggerKeys.map((t) => (
            <Fragment key={t}>
              <div
                className="ep-label"
                style={{
                  fontSize: 9,
                  padding: '8px 4px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end'
                }}>
                {TRIGGERS[t].name}
              </div>
              {verbKeys.map((v) => {
                const key = `${t}|${v}`
                const cellPatterns = cellMap[key] || []
                const catalogPattern = PATTERN_CATALOG.find(
                  (p) => p.trigger === t && p.verb === v
                )
                const isAccepted = cellPatterns.length > 0
                const isCatalogCell = !!catalogPattern
                return (
                  <div
                    key={v}
                    style={{
                      padding: '8px 6px',
                      minHeight: 54,
                      borderRadius: 3,
                      border: isAccepted
                        ? '1.5px solid rgba(184,90,58,0.5)'
                        : isCatalogCell
                        ? '1px dashed rgba(232,226,210,0.18)'
                        : '1px solid transparent',
                      background: isAccepted
                        ? 'rgba(184,90,58,0.08)'
                        : isCatalogCell
                        ? 'rgba(181,172,159,0.025)'
                        : 'transparent',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 3,
                      justifyContent: 'center',
                      alignItems: 'center',
                      textAlign: 'center'
                    }}>
                    {isAccepted ? (
                      cellPatterns.map((p, i) => (
                        <div
                          key={i}
                          className="ep-serif"
                          style={{
                            fontSize: 11.5,
                            fontStyle: 'italic',
                            color: '#B85A3A',
                            lineHeight: 1.2
                          }}
                          title={p.grammar}>
                          {p.canonName}
                          {cellPatterns.length === 1 && p.variantNotes?.length > 0 && (
                            <span
                              className="ep-muted"
                              style={{
                                fontSize: 9,
                                display: 'block',
                                fontStyle: 'normal',
                                marginTop: 2
                              }}>
                              ×{p.variantNotes.length} note
                              {p.variantNotes.length > 1 ? 's' : ''}
                            </span>
                          )}
                        </div>
                      ))
                    ) : isCatalogCell ? (
                      <div
                        className="ep-serif ep-muted"
                        style={{ fontSize: 10, fontStyle: 'italic', opacity: 0.55 }}
                        title={catalogPattern.desc}>
                        {catalogPattern.name}
                      </div>
                    ) : (
                      <div style={{ fontSize: 9, color: 'rgba(232,226,210,0.18)' }}>·</div>
                    )}
                  </div>
                )
              })}
            </Fragment>
          ))}
        </div>

        {/* Shared entities — the connective tissue */}
        {sharedEntities.length > 0 && (
          <div className="mb-6">
            <div className="ep-label mb-2" style={{ fontSize: 9.5 }}>
              Shared entities · the connective tissue ({sharedEntities.length})
            </div>
            <p
              className="ep-serif ep-muted"
              style={{ fontSize: 12.5, fontStyle: 'italic', marginBottom: 10 }}>
              Entities that appear across multiple accepted patterns. The more patterns they
              touch, the more central they are to your system.
            </p>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                gap: 8
              }}>
              {sharedEntities.map(([name, data]) => (
                <div
                  key={name}
                  style={{
                    padding: '8px 10px',
                    border: '1px solid rgba(232,226,210,0.12)',
                    borderRadius: 3,
                    background: '#221F18'
                  }}>
                  <div className="flex items-center justify-between mb-1">
                    <span
                      className={
                        isInCatalog(name) ? 'ep-pill ep-pill-entity' : 'ep-pill-entity-novel'
                      }>
                      {name}
                    </span>
                    <span className="ep-mono" style={{ fontSize: 10, color: '#B85A3A' }}>
                      ×{data.patterns.size}
                    </span>
                  </div>
                  <div
                    className="ep-serif ep-muted"
                    style={{ fontSize: 11, fontStyle: 'italic', lineHeight: 1.4 }}>
                    in {Array.from(data.patterns).join(', ')}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* All accepted entities list */}
        {sessionEntities.length > 0 && (
          <div className="mb-6">
            <div className="ep-label mb-2" style={{ fontSize: 9.5 }}>
              Accepted entities ({sessionEntities.length})
            </div>
            <div className="flex flex-wrap gap-1.5">
              {sessionEntities.map((e) => (
                <span
                  key={e.id}
                  className="ep-pill ep-pill-entity"
                  title={e.originalDescription}>
                  {e.canonicalName}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* What's missing — empty common cells */}
        {(() => {
          const acceptedCellKeys = new Set(Object.keys(cellMap))
          const allCatalogCells = PATTERN_CATALOG.map((p) => ({
            key: `${p.trigger}|${p.verb}`,
            name: p.name,
            trigger: p.trigger,
            verb: p.verb
          }))
          const missing = allCatalogCells.filter((c) => !acceptedCellKeys.has(c.key))
          if (sessionPatterns.length === 0 || missing.length === 0) return null
          return (
            <div className="mb-6">
              <div className="ep-label mb-2" style={{ fontSize: 9.5 }}>
                What might be missing
              </div>
              <p
                className="ep-serif ep-muted"
                style={{ fontSize: 12.5, fontStyle: 'italic', marginBottom: 8 }}>
                Catalog patterns you haven't accepted yet. Not all are needed — but if a
                system has Checkout but no Settlement, or Booking but no Notification,
                something's probably implicit.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {missing.map((c) => (
                  <span
                    key={c.key}
                    className="ep-pill"
                    style={{
                      background: 'rgba(181,172,159,0.05)',
                      borderColor: 'rgba(232,226,210,0.15)',
                      fontStyle: 'italic',
                      opacity: 0.7
                    }}
                    title={`${c.trigger}×${c.verb}`}>
                    {c.name}
                  </span>
                ))}
              </div>
            </div>
          )
        })()}
      </div>
    </div>
  )
}
