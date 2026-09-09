// web/src/displays.js — what this console renders differently from the kit.
//
// One registration, and it is the RENDERING half only: `displayFor` already
// answers `relation` for any foreign key, so there is nothing left to name
// (`FJS-D17` — a contributed renderer is two registrations and one name across
// them, and the naming half is only needed where the built-in table has no
// name for the thing).
//
// What the kit cannot know is that this app's reads carry the related row.
// `Cell` renders a relation as its id and is right to: it is handed one record
// and cannot fetch another. Every list here declares an `include`, so the name
// is already on the record — and a fleet console showing a machine's id where
// it could show its hostname is the failure this whole surface exists to end,
// one column along from a price rendered in cents.
import { registerDisplayComponent } from '@frontierjs/ui/controls'
import RelationCell from './RelationCell.mesa'

registerDisplayComponent('relation', RelationCell)
