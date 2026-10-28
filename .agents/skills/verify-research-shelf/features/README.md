# Research Shelf verification map

| Feature                             | User action                                     | Required consumer evidence                                                                |
| ----------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [First delivery](first-delivery.md) | Connect Vana, approve, return to conversations  | Correct binding, SDK read, durable save, actual DOM, acknowledgement after render         |
| [Iteration](iteration.md)           | Rerun the connector, then Read latest           | Changed content, same grant and record identity, save, render, acknowledgement, retention |
| [Recovery](recovery.md)             | Return after interruption or retry confirmation | Saved content stays usable, confirmation avoids rereading, lost durability is detected    |

Each row has controlled and live boundaries. Real approval, provider collection
and source-code iteration require the [live procedure](../references/live-acceptance.md).
Synthetic service responses establish neither consent nor provider behavior.
The result retains those blocked clauses when consumer assertions pass. This
verifier does not require a new provider, native runtime or automatic funding.
