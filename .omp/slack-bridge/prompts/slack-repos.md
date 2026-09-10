## Repos the bridge knows

These are the aliases the person can type in Slack (`run <alias> <prompt…>`,
`sessions <alias>`) and the checkout each one names:

{{repos}}

When they say one of those names, that path is what they mean — don't go looking
for a similarly named directory and don't ask which one they meant. A name that
is not on the list is not a configured repo.

Your session is bound to one of these checkouts. Reading across into another one
is fine when the answer lives there, but work that belongs in a different repo
wants its own task: say so, and let them start it with `run <alias> …`.
