# FrontierJS — Soul

FrontierJS exists to make software **knowable**.

Not smaller. Not more powerful. Not friendlier to configure. Knowable — meaning a
developer can look at a piece of the system and correctly predict where it lives,
who owns it, and what happens when it changes, without having read the whole
codebase first.

Every decision FJS makes, including the ones with no obviously correct answer,
gets measured against that.

## What is true

Most software doesn't get complicated because it grows large. It gets complicated
because one truth gets copied, renamed, wrapped, and re-explained until nobody is
sure which version is real any more.

So FJS starts every hard question the same way: what is actually true here? Where
is that truth declared? Who owns it? What is merely derived from it — and does
the code admit that it's derived?

Answer those honestly and most designs sort themselves out.

## The cost nobody bills for

There's a cost to software that never shows up in a bundle size or a query plan:
what a developer has to hold in their head to work safely inside it.

Every duplicate name, every hidden dependency, every convention nobody wrote
down, every option that exists because removing it felt unkind — each one is a
small loan against that budget. Take enough of them and a developer stops
understanding the system and starts memorising it instead, which is a worse and
far more fragile skill.

FJS treats a smaller mental model as a real design goal, not a nice-to-have that
loses to features when the schedule gets tight. When two designs both work, the
one that lets a developer predict more from less knowledge wins.

## One home

Two packages announcing the same fact under different names isn't a naming
problem. It's a sign the system never decided where that fact actually lives.

A fact should have one origin. A concept should have one name. A capability
should have one owner — not because tidiness is a virtue in itself, but because a
fact with two homes is a fact that can quietly disagree with itself, and nobody
notices until it matters.

Where FJS finds duplication, it looks for the side that can become a projection
of the other. Where it finds unclear ownership, it looks for the missing
boundary.

## A shape you can hold

Knowable isn't an attitude, it has to be a shape. In FJS that shape is a schema
you can read in one sitting, and three realms that everything else belongs to:
the data, the service over it, the interface over that. Growth happens outward
and traces back.

That's what lets someone predict where a thing lives before they go looking. A
feature that fits nowhere in that picture isn't necessarily wrong — but it is
asking for a fourth place to look, and it should have to say so out loud.

## The paved road, and what it means when people leave it

FJS is opinionated on purpose. Developers can't think clearly inside a system
where every decision is up for negotiation, so FJS picks a default, makes it
excellent, and expects most people to use it without a second thought.

But the road isn't sacred. One developer leaving it might be an edge case. The
same workaround showing up in the same place, over and over, is the road telling
us something.

The escape hatch is feedback — and the framework that owns the paved road owns
the job of listening when people keep stepping off it, not just widening the
shoulder with another config flag and calling it handled.

## Nothing true only in someone's head

A rule that lives only in the author's head is already broken for everyone else.
The same goes for a fact the framework derives and nobody can read: correctness
that can't be seen is indistinguishable from luck, and it holds until something
quietly stops holding it.

So FJS writes things down, and where it can, it makes the writing check itself —
a generated artefact somebody reviews, a diff that appears when a fact stops
being true. Not out of process fondness. It's the only way a thing stays known
after the person who knew it has moved on.

That includes admitting the gaps. Where something isn't enforced, saying so is
worth more than leaving a blank that reads like enforcement.

## Wrong is allowed

FJS can say *this is the better shape* and mean it. It can also say, later, *we
were wrong* — and mean that too.

A decision earns the right to stay by surviving contact with real use, not by
being old or having a name attached to it. When code and doctrine disagree, FJS
doesn't reflexively defend the doctrine — it holds a hearing, and writes down
what changed its mind and why, so the next person doesn't have to relitigate it
from nothing.

## Not every problem is the framework's to solve

Some complexity belongs to the problem a developer is actually solving. Some gets
added on top, by us.

FJS tries hard to tell the difference. It shouldn't ask for ceremony the problem
never demanded, and it shouldn't turn a convention into an abstraction just
because the abstraction happened to be lying around. The application is still the
application; FJS is a path through it, not a replacement for owning it.

## Small in the middle, capable at the edges

A framework's centre should be explainable in a short conversation. Everything it
grows afterward — plugins, hooks, realm boundaries, pieces that can be removed
without ceremony — should compose against that small centre rather than quietly
becoming a second one.

When a new feature needs a new concept, a new term, and a new exception to
explain how it fits, that cost should be visible before it ships — not discovered
later by whoever has to explain it to the next person.

## Territory, not blueprint

FrontierJS is being built at the edge of what's already settled, which means some
of it is decided and some of it genuinely isn't yet.

A framework at that stage shouldn't pretend otherwise. It marks what's been ruled
on, keeps what's still open visibly open, and makes it possible to change course
later without losing the record of why the current path was chosen. The map
should get clearer as the territory grows — not just bigger.

## Where this fits

The philosophy, the invariants, and the decision log are where FJS's architecture
actually gets enforced — that's where *is this true* has a checkable answer. This
document doesn't replace any of that, and it isn't binding the way they are.

It's the disposition FJS brings to the questions those documents haven't answered
yet.

## The test

When there's no ruling on record, FJS asks:

- What is true here, and where is it declared?
- Does this leave the developer with less to remember, or more?
- Does this give the fact, capability, or decision a single clear home?
- Is this complexity the problem's, or did we just add it?
- Can this be wrong without anything saying so?
- If people keep working around this, what is that telling us?
- Between two reasonable choices, which one is easier to predict six months from
  now?

If the answer sharpens the picture, it is probably moving in the right direction.
If it only adds one more thing to know, it probably isn't.
