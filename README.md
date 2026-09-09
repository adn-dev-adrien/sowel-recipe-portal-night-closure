# sowel-recipe-portal-night-closure

> **Publier une version** : bumper `manifest.json` + `package.json`, committer, puis `git tag vX.Y.Z && git push origin vX.Y.Z`. Le workflow `Release` teste, build, empaquette et crée la release GitHub. Ne pas lancer `gh release create` à la main : la commande crée aussi le tag, ce qui déclenche le workflow, qui trouverait alors sa propre release déjà là et échouerait.

Recette Sowel qui **referme le portail toute seule**, sur une installation dont le seul retour est un **contact de fermeture qui rate parfois la détection** — le portail s'arrête deux ou trois centimètres avant le capteur, il est fermé, et le capteur dit « ouvert ».

Elle répond à la même demande de deux façons :

- un **mode fermeture automatique** armable — tant qu'il est armé, **chaque** ouverture (télécommande, clavier, livreur, peu importe) déclenche un délai puis une refermeture. Il s'arme d'un clic sur la tuile du tableau de bord, ou tout seul à des heures programmées ;
- la **fermeture du soir**, à l'heure choisie, que quelqu'un y ait pensé ou non.

> **Un seul veilleur pour les deux.** C'est délibéré : sur un portail à impulsion séquentielle, deux automatismes qui tiennent chacun leur échéance envoient **deux** impulsions pour une seule ouverture — la première ferme, la seconde rouvre. Une seule refermeture en attente à la fois est la seule forme qui ne peut pas faire ça.

## L'asymétrie, qui est tout le sujet

Ce capteur ne ment que dans un sens. L'aimant ne peut pas se retrouver sur le contact si le portail n'est pas contre sa butée : un « fermé » n'est jamais faux. Un « ouvert », lui, ne veut rien dire tout seul — il couvre le portail réellement ouvert **et** le portail fermé trop court.

> **« fermé » est une certitude. « ouvert » n'est qu'un soupçon.**

Toute la recette découle de là : elle ne manœuvre jamais le portail sur la foi d'un « ouvert » brut. Elle croise trois sources :

| Source | Ce qu'elle vaut |
| --- | --- |
| Le **niveau** du capteur | Cru uniquement quand il dit « fermé » |
| Les **transitions** du capteur | Un front `fermé → ouvert` est une **vraie** ouverture : c'est le seul moment où ce matériel dit la vérité sur une ouverture |
| Ce que la recette a elle-même **commandé** | Une manœuvre qu'elle a ordonnée et chronométrée est une preuve que le capteur ne peut pas fournir |

De là elle tient une **conviction**, qui n'est pas ce que dit le capteur :

- `closed` — le contact l'a confirmé (certitude) ;
- `open` — un front `fermé → ouvert` a été observé (certitude d'une ouverture) ;
- `doubt` — le contact dit « ouvert » sans rien pour l'étayer : le portail est peut-être ouvert, peut-être fermé trop court.

## Pourquoi une impulsion ne peut pas être envoyée à l'aveugle

Sur votre motorisation, la commande Sowel est une **impulsion séquentielle** : elle bascule, exactement comme la télécommande. Sur un portail ouvert, elle ferme. Sur un portail fermé — donc sur le cas où votre capteur ment — **elle ouvre**. Et rien d'observable ne distingue les deux : après l'impulsion, le capteur dit « ouvert » dans les deux cas.

C'est une ambiguïté de parité, et elle est irréductible avec ce matériel : aucune suite d'impulsions à l'aveugle ne peut la lever. La recette ne fait donc pas semblant de la lever — elle l'encadre.

### Quand la recette est sûre d'elle

Si elle a **vu** l'ouverture (front `fermé → ouvert`), elle sait que le portail est ouvert : l'impulsion le ferme, sans pari. C'est le cas nominal d'une soirée normale — le portail était fermé et confirmé, quelqu'un l'ouvre, la recette le voit.

### Quand elle doute : le recalage borné

Si le contact dit « ouvert » depuis un moment sans front observé (typiquement : une fermeture précédente que le capteur n'a jamais vue), la recette lance une séquence bornée :

1. une impulsion ;
2. l'attente d'une manœuvre complète (`travelTime` + 10 s de marge) ;
3. la relecture du contact.

Elle **s'arrête à la seconde où le contact dit « fermé »** — c'est une certitude, et c'est le but. Chaque nouvelle tentative est une manœuvre de fermeture neuve, donc une chance neuve pour un portail qui ne s'arrête court que *parfois* de se poser correctement sur son contact. C'est là que se gagne le cas courant.

Si rien n'est jamais confirmé, la recette ne parie pas en silence. Elle termine la séquence sur la parité que vous avez choisie, **écrit l'alerte**, et continue de regarder : un contact tardif (le portail qui se pose, une bourrasque) lève l'alerte tout seul.

| `doubtPolicy` | Fin de séquence | À utiliser si |
| --- | --- | --- |
| **`restore`** *(défaut)* | Nombre pair d'impulsions : le portail est **remis dans son état initial** | Défaut volontaire : un portail qui affiche « ouvert » à 22 h 30 est le plus souvent un portail fermé avec un capteur aveugle. La recette refuse de vous ouvrir un portail fermé pour la nuit. |
| `force_close` | Nombre impair : la séquence finit sur une **manœuvre de fermeture** | Vous savez que chez vous un « ouvert » à cette heure-là est vraiment un portail ouvert |
| `alert_only` | Aucune impulsion en cas de doute | Vous voulez être prévenu et aller voir, point |

Dans les trois cas, la conviction retombe à `doubt`, `alarm` passe à `true`, et le journal dit exactement ce qui s'est passé.

## Les deux configurations qui suppriment le problème

Le recalage est une parade, pas une solution. Deux câblages font disparaître l'ambiguïté, et la recette les gère tous les deux :

### `close_command` — une commande « fermer » dédiée

Si la motorisation expose une commande qui ne fait que fermer, fermer un portail déjà fermé ne fait rien : **le capteur menteur cesse complètement de compter**. La recette envoie la commande à l'heure dite, sans se demander ce que dit le contact.

Trois façons d'y arriver, par ordre de coût :

- une **valeur d'énumération** dédiée sur la commande existante (`CLOSE`, `DOWN`… — visible dans les valeurs de l'ordre lié) : renseignez-la dans `closeCommandValue` ;
- un **second relais** (R2 sur une carte LoRa, un second canal Zigbee) câblé sur l'entrée « fermeture » de la platine — la plupart des platines résidentielles en ont une, à côté de l'entrée séquentielle. Liez-le comme ordre du portail et mettez son alias dans `closeCommandAlias` ;
- une commande radio **descente** (Somfy RTS/IO) si votre motorisation est pilotée par là.

### `pulse_autoclose` — la refermeture automatique

Si la platine est en mode automatique (elle referme seule après un délai), une impulsion converge toujours vers « fermé », quel que soit l'état de départ. Déclarez le délai dans `autoCloseDelay` et la recette attend le cycle complet avant de relire le contact.

Dans ces deux modes, une fermeture non confirmée par le capteur **ne lève pas d'alerte** : la manœuvre est la garantie, le silence du contact n'est qu'un défaut de capteur. Le journal le dit (`portail réputé fermé, capteur à recaler`) et l'état `confirmed` reste à `false`.

## Le mode fermeture automatique

La pastille de la tuile fait tout : **Arrêt** ↔ **Armé**, un clic. Tant qu'il est armé, un front `fermé → ouvert` déclenche le délai `reopenGrace`, et à l'échéance le portail est refermé — avec exactement le même raisonnement que la fermeture du soir (jamais d'impulsion à l'aveugle, relecture du capteur, tentatives bornées).

Le mode **reste armé après une refermeture** : l'ouverture suivante est traitée pareil. Il n'y a rien à réarmer.

Il s'arme aussi tout seul, si vous renseignez `autoCloseFrom` / `autoCloseUntil` (par exemple 08:00 → 20:00). La pastille et la programmation écrivent le même réglage : une coupure manuelle tient jusqu'à la prochaine heure programmée, pas au-delà. Laissez les deux vides pour ne piloter le mode qu'à la main.

Trois précautions qui comptent :

- **Armer le mode ne manœuvre jamais le portail.** C'est pour ça que la tuile ne demande pas de confirmation : le clic n'ouvre ni ne ferme rien, il arme une veille.
- **Armer au-dessus d'un portail déjà ouvert** ne lance le décompte que si la recette a **vu** l'ouverture (conviction `open`). Sur un simple « ouvert » du contact sans front observé (conviction `doubt`), elle ne bouge pas : une impulsion là-dessus pourrait *ouvrir* un portail fermé.
- **Un redémarrage ne lance jamais de refermeture**, même mode armé et portail ouvert. Armer depuis la tuile est un geste de quelqu'un qui est devant le portail ; un redémarrage du moteur ne l'est pas, et une impulsion que personne n'a demandée à 3 h du matin serait le pire de ce que cette recette peut faire. C'est la prochaine vraie ouverture qui réarme.

Pendant l'attente, un **décompte à la seconde** s'affiche sur la ligne de l'instance et sur la tuile. Si le portail se referme tout seul entre-temps, la refermeture est annulée.

### La recette cède à la minuterie du portail

Si le cœur tient déjà sa propre échéance sur ce portail — la minuterie « ouvrir pour 15 min » de la tuile de l'équipement, spec 174 — **la recette n'en arme pas une seconde** et laisse le cœur fermer.

Ce n'est pas une politesse, c'est une nécessité. Les deux échéances envoient la **même** impulsion : la première ferme le portail, la seconde le **rouvre**. Et le cœur ne peut pas nous voir pour se désarmer tout seul — sa règle « retour fait à la main » exige une mesure miroir sur l'alias de l'ordre, ce qu'une impulsion séquentielle de portail n'a pas, son propre code le dit. C'est donc à la recette de céder.

Sur le fond aussi, c'est le bon choix : « ouvrir pour 15 minutes » est une demande explicite, faite à l'instant, par quelqu'un. Le mode armé est un réglage par défaut. L'explicite l'emporte. La vérification est refaite à l'échéance, au cas où la minuterie du portail serait armée après coup.

## La surveillance de nuit

Fermer à 22 h 30 ne suffit pas à passer la nuit fermé. Entre `closingTime` et `watchUntil` (06:00 par défaut), une **vraie** ouverture — un front `fermé → ouvert`, donc une information fiable — réarme une fermeture après `reopenGrace` (10 min par défaut, le temps de rentrer la voiture et de décharger le coffre). Si le portail se referme tout seul pendant ce délai, la fermeture est annulée.

Laissez `watchUntil` vide pour n'agir qu'à l'heure de fermeture.

Une limite, dite franchement : cette surveillance ne vaut que si la fermeture précédente a été **confirmée**. Après une fermeture que le capteur n'a pas vue, le contact affiche déjà « ouvert » — une ouverture réelle ne produit alors aucun front, et rien ne peut la détecter. C'est une raison de plus de viser `close_command`, ou de recaler l'aimant.

Au matin (`watchUntil`), une fermeture non confirmée **ne survit pas à la nuit** : la conviction retombe à `doubt` plutôt que de rester sur un « je l'ai fermé moi-même » périmé. Le soir suivant repart d'une page blanche.

## Paramètres

| Paramètre | Défaut | Rôle |
| --- | --- | --- |
| `portal` | — | Le portail (équipement de type `gate`, choisissable dans n'importe quelle zone) |
| `closingTime` | `22:30` | L'heure à laquelle le portail doit être fermé, tous les soirs |
| `watchUntil` | `06:00` | Fin de la surveillance de nuit. Vide = n'agir qu'à l'heure de fermeture |
| `reopenGrace` | `10m` | Délai laissé à celui qui vient d'ouvrir avant de refermer — **1, 3, 5 ou 10 min**. Sert au mode armé comme à la veille de nuit |
| `autoCloseFrom` | — | Heure d'armement automatique du mode. Vide = mode piloté à la main |
| `autoCloseUntil` | — | Heure de désarmement. Vide = le mode reste armé jusqu'à ce que vous le coupiez |
| `commandMode` | `pulse_toggle` | Ce que fait la commande : impulsion qui bascule / impulsion + refermeture auto / commande de fermeture dédiée |
| `closeCommandAlias` | `command` | Alias de la commande « fermer » (mode dédié) |
| `closeCommandValue` | — | Valeur envoyée (mode dédié). Vide = valeur par défaut de la liaison |
| `travelTime` | `40s` | Durée d'une manœuvre complète, avant de relire le capteur |
| `autoCloseDelay` | `2m` | Délai de refermeture automatique de la platine (mode `pulse_autoclose`) |
| `attempts` | `2` | Manœuvres tentées avant d'abandonner et d'alerter (1 à 5) |
| `doubtPolicy` | `restore` | Fin de séquence quand rien n'est confirmé (voir plus haut) |

Deux impulsions par défaut, ce n'est pas un chiffre au hasard : en mode `restore`, c'est exactement **un cycle ouverture/fermeture complet** — deux chances données au contact, et le portail revient là où il était.

## Ce que la recette expose

Ces clés d'état sont lisibles dans la fiche de l'instance, et utilisables comme source de notification (Réglages → Notifications) :

| Clé | Valeurs | Ce qu'elle dit |
| --- | --- | --- |
| `alarm` | `true` / `false` | **La clé à brancher sur une notification.** `true` = la recette ne peut pas garantir que le portail est fermé |
| `belief` | `closed` / `open` / `doubt` | Ce que la recette croit, par opposition à ce que dit le capteur |
| `confirmed` | `true` / `false` | La dernière fermeture a-t-elle été confirmée par le contact |
| `portalState` | `open` / `closed` / `unknown` | Le capteur, brut |
| `autoClose` | `off` / `on` | L'état du mode — c'est la pastille cliquable |
| `summary` | texte | La ligne de résumé affichée sous le nom de l'instance et sur la tuile |
| `timerExpiresAt` | ISO-8601 / `null` | Échéance de la refermeture en attente — c'est le décompte |
| `status` | `idle` / `closing` / `watching` | Où en est la recette |
| `nextClosing` | `HH:MM` | Prochaine fermeture |
| `lastClosureAt`, `lastConfirmedAt`, `pulses`, `attempt` | | Traçabilité de la dernière séquence |

`alarm` est volontairement `false` quand la fermeture est garantie par la commande et seulement invisible au capteur : une alerte tous les soirs n'est plus une alerte.

## Comportement

- Les ordres ne partent que sur **décision** (heure de fermeture, réouverture constatée mode armé ou nuit) : une commande manuelle entre deux n'est jamais écrasée.
- Couper le mode annule la refermeture en attente — **sauf** si la veille de nuit la réclame aussi : elle n'est pas coupée par la pastille.
- `stop()` (instance désactivée, paramètres modifiés, mise à jour de la recette, arrêt du moteur) annule tous les minuteurs et **interrompt une séquence en cours** — le portail n'est pas manœuvré.
- Le mode survit à un redémarrage, mais **jamais un décompte** : une échéance périmée afficherait un compte à rebours qui ne mène nulle part. Une plage horaire l'emporte sur l'état persisté — redémarrer dans la plage revient armé.
- Au redémarrage : si le contact dit « fermé », c'est une certitude et la recette repart de là. Sinon une conviction `open` persistée (une ouverture réellement observée) est conservée, une conviction `closed` jamais confirmée est oubliée.
- Les fronts sont dédupliqués : le bus republie `equipment.data.changed` avec des valeurs inchangées, et l'état dérivé du portail arrive toujours avec `previous: undefined`.
- Un `unknown` (l'état d'attente que Sowel pose après une commande de portail) n'est jamais pris pour une information.

## La vraie réparation

Cette recette rend le portail utilisable tel qu'il est ; elle ne répare pas le capteur. Si le journal vous répète tous les soirs `aucune confirmation après 2 manœuvre(s)`, c'est qu'il reste deux choses à faire, dans cet ordre : **rapprocher l'aimant** (une cale, un aimant plus long, un déplacement du contact de deux centimètres), et à défaut **câbler une entrée fermeture dédiée**. La recette vous le dira tous les soirs plutôt que de faire semblant.

## Installation sur votre instance

Sur la page **Plugins → Store → Sources personnelles**, ajoutez le dépôt, puis installez depuis le store (le modal TOFU affiche la version et l'empreinte SHA256 — confirmez). La recette apparaît alors dans **Recettes** avec le badge *Personnel*.

Ou par l'API :

```bash
curl -X POST http://<sowel>/api/v1/plugins/sources -d '{"repo":"adn-dev-adrien/sowel-recipe-portal-night-closure"}'
curl -X POST http://<sowel>/api/v1/plugins/install -d '{"repo":"adn-dev-adrien/sowel-recipe-portal-night-closure"}'
# → 409 avec {version, sha256} ; rejouer avec {"confirmed": true, "expectedSha256": "..."}
```

## Développement

```bash
npm install
npm test          # vitest
npm run build     # tsc → dist/
```

Les tests simulent le portail *et* son capteur menteur : un état physique, un contact qui ne le voit qu'après un nombre paramétrable de fermetures, et une impulsion qui bascule. C'est ce double qui permet de vérifier ce qui compte — que le mode `restore` remet bien le portail où il était, que la séquence s'arrête à la première confirmation, et qu'une commande dédiée part quoi qu'en dise le capteur.

## Licence

AGPL-3.0
