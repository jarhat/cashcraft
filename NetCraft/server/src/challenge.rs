use super::*;
use std::collections::BTreeMap;

const MAX_INVITEES: usize = 8;
const ROUND_SECONDS: u64 = 300;
const INVITE_SECONDS: u64 = 120;
const FLAG_OFFSET: i32 = 28;

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Ctf,
    Pvp,
    Pve,
    Mining,
}

impl Mode {
    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "ctf" => Self::Ctf,
            "pvp" => Self::Pvp,
            "pve" => Self::Pve,
            "mining" => Self::Mining,
            _ => return None,
        })
    }
}

struct Round {
    owner: u32,
    mode: Mode,
    invitees: BTreeSet<String>,
    scores: BTreeMap<u32, u64>,
    red_flag: Option<u32>,
    blue_flag: Option<u32>,
    ends: u64,
    tip: Option<String>,
    started: bool,
}

#[derive(Default)]
pub(super) struct Challenges {
    rounds: BTreeMap<String, Round>,
    serial: u64,
    tip: Option<(String, u64)>,
}

pub(super) fn eligible(player: &Player) -> bool {
    player.verified_wallet_address.is_some()
        && player.verified_wallet_address == player.reward_address
}

fn message(players: &HashMap<u32, Player>, id: u32, packet: &str) {
    if let Some(player) = players.get(&id) {
        send(player, format!("CG,{packet}\n"));
    }
}

fn notify(players: &HashMap<u32, Player>, round: &Round, text: &str) {
    for &id in round.scores.keys() {
        message(players, id, &format!("status,{text}"));
        if let Some(player) = players.get(&id) {
            send(player, format!("T,{text}\n"));
        }
    }
}

pub(super) fn command(state: &mut State, id: u32, args: &[&str]) -> rusqlite::Result<()> {
    let State {
        challenges,
        players,
        db,
        ..
    } = state;
    let Some(player) = players.get(&id) else {
        return Ok(());
    };
    let error = |text: &str| message(players, id, &format!("status,{text}"));
    if args == ["list"] {
        let mut packet = format!("CG,clear,{id}\n");
        let mut ranks = db.prepare("SELECT ore, blocks FROM cashaddr.ore_scores WHERE miner=?1")?;
        let mut blocks =
            db.prepare("SELECT blocks FROM cashaddr.challenge_mining WHERE address=?1")?;
        let mut live: Vec<_> = players.iter().filter(|(_, p)| eligible(p)).collect();
        live.sort_unstable_by_key(|(&id, _)| id);
        let mut addresses = HashSet::new();
        for (&member, other) in live {
            let address = other.reward_address.as_deref().unwrap();
            if member != id && player.reward_address.as_deref() == Some(address) {
                continue;
            }
            if !addresses.insert(address) {
                continue;
            }
            let mut counts = [0i64; 3];
            for entry in ranks.query_map([ore_miner(other)], |row| {
                Ok((row.get::<_, i32>(0)?, row.get::<_, i64>(1)?))
            })? {
                let (ore, count) = entry?;
                if let Some(index) = TRACKED_ORES.iter().position(|&item| item == ore) {
                    counts[index] = count;
                }
            }
            let mined = blocks
                .query_row([address], |row| row.get::<_, i64>(0))
                .optional()?
                .unwrap_or(0);
            packet.push_str(&format!(
                "CG,player,{member},{},{},{},{},{mined}\n",
                other.name, counts[0], counts[1], counts[2]
            ));
        }
        packet.push_str(&format!("CG,listed,{}\n", u8::from(eligible(player))));
        send(player, packet);
        return Ok(());
    }
    if !eligible(player) {
        error("Connect and verify your wallet in-game before playing a challenge.");
        return Ok(());
    }
    if player.admin.granted && !matches!(args, ["list"]) {
        error("Admin tools are not available in challenges. Use a regular player wallet.");
        return Ok(());
    }
    match args {
        ["invite", mode, invitees @ ..]
            if !invitees.is_empty() && invitees.len() <= MAX_INVITEES =>
        {
            let Some(mode) = Mode::parse(mode) else {
                return Ok(());
            };
            if challenges
                .rounds
                .values()
                .any(|round| round.owner == id || round.scores.contains_key(&id))
            {
                error("Finish your current challenge first.");
                return Ok(());
            }
            let ids: BTreeSet<_> = invitees
                .iter()
                .filter_map(|id| id.parse::<u32>().ok())
                .collect();
            let mut addresses = HashSet::from([player.reward_address.as_deref()]);
            if ids.len() != invitees.len()
                || !ids.iter().all(|other| {
                    players.get(other).is_some_and(|p| {
                        eligible(p)
                            && !p.admin.granted
                            && addresses.insert(p.reward_address.as_deref())
                    })
                })
            {
                error("Select distinct players with connected wallets.");
                return Ok(());
            }
            challenges.serial += 1;
            let key = format!("{:x}-{:x}", world_time(), challenges.serial);
            let round = Round {
                owner: id,
                mode,
                invitees: ids
                    .iter()
                    .filter_map(|id| players[id].reward_address.clone())
                    .collect(),
                scores: BTreeMap::from([(id, 0)]),
                red_flag: None,
                blue_flag: None,
                ends: world_time() + INVITE_SECONDS,
                tip: None,
                started: false,
            };
            message(players, id, &format!("created,{key}"));
            for other in ids {
                message(players, other, &format!("invite,{key},{}", player.name));
                if let Some(target) = players.get(&other) {
                    send(
                        target,
                        format!(
                            "T,{} invited you to a challenge. Open the trophy to accept.\n",
                            player.name
                        ),
                    );
                }
            }
            challenges.rounds.insert(key, round);
        }
        ["join", key] => {
            if challenges
                .rounds
                .values()
                .any(|round| round.scores.contains_key(&id))
            {
                error("You are already in a challenge.");
            } else if let Some(round) = challenges.rounds.get_mut(*key).filter(|round| {
                !round.started
                    && round.ends > world_time()
                    && player
                        .reward_address
                        .as_ref()
                        .is_some_and(|address| round.invitees.contains(address))
                    && !round.scores.keys().any(|member| {
                        players
                            .get(member)
                            .is_some_and(|p| p.reward_address == player.reward_address)
                    })
            }) {
                round.scores.insert(id, 0);
                notify(
                    players,
                    round,
                    &format!("{} joined the challenge.", player.name),
                );
            } else {
                error("This challenge is unavailable for your current game connection.");
            }
        }
        ["start", key] => {
            if let Some(round) = challenges
                .rounds
                .get_mut(*key)
                .filter(|round| round.owner == id && !round.started && round.ends > world_time())
            {
                round
                    .scores
                    .retain(|member, _| players.get(member).is_some_and(eligible));
                if round.scores.len() < 2 {
                    error("At least one invited player must accept.");
                } else if round.mode == Mode::Ctf && round.scores.len() % 2 != 0 {
                    error("Capture the Flag needs an even number of players.");
                } else if round.mode == Mode::Mining
                    && !challenges
                        .tip
                        .as_ref()
                        .is_some_and(|(_, time)| world_time().saturating_sub(*time) <= 20)
                {
                    error("A fresh BCH block tip is unavailable.");
                } else {
                    round.started = true;
                    round.ends = world_time()
                        + if round.mode == Mode::Mining {
                            7200
                        } else {
                            ROUND_SECONDS
                        };
                    round.tip = challenges.tip.as_ref().map(|(hash, _)| hash.clone());
                    let text = match round.mode {
                        Mode::Ctf => "Find the enemy flag in the top-down World view. Carry it back to your home base.",
                        Mode::Pvp => "Survive against the other challengers. Aim at a nearby opponent and attack with your pickaxe.",
                        Mode::Pve => "Survive world hazards and hostile mobs. The last surviving challenger wins.",
                        Mode::Mining => "Mine natural blocks until the server sees a new BCH block tip. Placed blocks do not count.",
                    };
                    notify(players, round, text);
                    for &member in round.scores.keys() {
                        message(players, member, &format!("started,{key}"));
                    }
                    if round.mode == Mode::Ctf {
                        for (index, &member) in round.scores.keys().enumerate() {
                            message(
                                players,
                                member,
                                if index % 2 == 0 {
                                    "status,Your base is west."
                                } else {
                                    "status,Your base is east."
                                },
                            );
                        }
                    }
                }
            } else {
                error("Only the host can start a pending challenge.");
            }
        }
        _ => error("Invalid challenge action."),
    }
    Ok(())
}

fn same_team(round: &Round, a: u32, b: u32) -> bool {
    let team = |id| {
        round
            .scores
            .keys()
            .position(|&member| member == id)
            .unwrap()
            % 2
    };
    team(a) == team(b)
}

impl Challenges {
    pub(super) fn mined(&mut self, id: u32) {
        for round in self
            .rounds
            .values_mut()
            .filter(|r| r.started && r.mode == Mode::Mining)
        {
            if let Some(score) = round.scores.get_mut(&id) {
                *score = score.saturating_add(1);
            }
        }
    }

    pub(super) fn can_attack(&self, id: u32, target: u32) -> bool {
        id != target
            && self.rounds.values().any(|r| {
                r.started
                    && r.scores.get(&id) == Some(&0)
                    && r.scores.get(&target) == Some(&0)
                    && (r.mode == Mode::Pvp || (r.mode == Mode::Ctf && !same_team(r, id, target)))
            })
    }

    pub(super) fn eliminated(&mut self, id: u32) {
        for r in self.rounds.values_mut().filter(|r| r.started) {
            if matches!(r.mode, Mode::Pvp | Mode::Pve) {
                if let Some(score) = r.scores.get_mut(&id) {
                    *score = 1;
                }
            }
            if r.red_flag == Some(id) {
                r.red_flag = None;
            }
            if r.blue_flag == Some(id) {
                r.blue_flag = None;
            }
        }
    }

    pub(super) fn set_tip(&mut self, hash: String) {
        self.tip = Some((hash, world_time()));
    }

    pub(super) fn tick(&mut self, players: &HashMap<u32, Player>) {
        let now = world_time();
        let tip = self.tip.as_ref().map(|(hash, _)| hash);
        self.rounds.retain(|key, round| {
            let online = |id: &u32| {
                players
                    .get(id)
                    .is_some_and(|player| eligible(player) && !player.admin.granted)
            };
            let close = |round: &Round| {
                for (&id, player) in players {
                    if round.scores.contains_key(&id)
                        || player
                            .reward_address
                            .as_ref()
                            .is_some_and(|address| round.invitees.contains(address))
                    {
                        message(players, id, &format!("closed,{key}"));
                    }
                }
            };
            if !round.started {
                let keep = now < round.ends && online(&round.owner);
                if !keep {
                    notify(players, round, "Challenge invitation expired.");
                    close(round);
                }
                return keep;
            }
            let result = match round.mode {
                Mode::Mining if tip.is_some() && tip == round.tip.as_ref() && now < round.ends => {
                    return true
                }
                Mode::Mining if now >= round.ends => None,
                Mode::Mining => {
                    let mut scores: Vec<_> =
                        round.scores.iter().filter(|(id, _)| online(id)).collect();
                    scores.sort_unstable_by_key(|(_, score)| std::cmp::Reverse(**score));
                    scores
                        .first()
                        .filter(|(_, score)| {
                            **score > 0 && scores.get(1).is_none_or(|(_, second)| second < score)
                        })
                        .map(|(id, _)| **id)
                }
                Mode::Pvp | Mode::Pve => {
                    let mut alive = round
                        .scores
                        .iter()
                        .filter(|(id, score)| **score == 0 && online(id));
                    let first = alive.next();
                    if alive.next().is_some() && now < round.ends {
                        return true;
                    }
                    if now >= round.ends {
                        None
                    } else {
                        first.map(|(id, _)| *id)
                    }
                }
                Mode::Ctf => {
                    if now >= round.ends {
                        notify(players, round, "Challenge ended without a winner.");
                        close_map(players, round);
                        close(round);
                        return false;
                    }
                    let spawn = spawn_position()[0] as i32;
                    let bases = [spawn - FLAG_OFFSET, spawn + FLAG_OFFSET];
                    let mut active_teams = [false; 2];
                    for (index, (&id, _)) in round.scores.iter().enumerate() {
                        let team = index % 2;
                        if !online(&id) {
                            if round.red_flag == Some(id) {
                                round.red_flag = None;
                            }
                            if round.blue_flag == Some(id) {
                                round.blue_flag = None;
                            }
                            continue;
                        }
                        active_teams[team] = true;
                        let [x, y, z, _, _] = players[&id].position;
                        if y < 32.0 || z.abs() > 3.0 {
                            continue;
                        }
                        let base = f64::from(bases[team]);
                        let enemy = f64::from(bases[1 - team]);
                        let home_flag_present = (if team == 0 {
                            round.red_flag
                        } else {
                            round.blue_flag
                        })
                        .is_none();
                        let flag = if team == 0 {
                            &mut round.blue_flag
                        } else {
                            &mut round.red_flag
                        };
                        if (x - enemy).abs() <= 3.0 && flag.is_none() {
                            *flag = Some(id);
                            notify(
                                players,
                                round,
                                &format!("{} took the enemy flag!", players[&id].name),
                            );
                        } else if (x - base).abs() <= 3.0 && *flag == Some(id) && home_flag_present
                        {
                            let color = if team == 0 { "West" } else { "East" };
                            notify(
                                players,
                                round,
                                &format!("{color} team wins Capture the Flag!"),
                            );
                            close_map(players, round);
                            close(round);
                            return false;
                        }
                    }
                    if active_teams == [true, true] {
                        let flag = |carrier: Option<u32>, home: i32| {
                            carrier
                                .and_then(|id| players.get(&id))
                                .map_or((home, 0), |p| {
                                    (p.position[0].round() as i32, p.position[2].round() as i32)
                                })
                        };
                        let (wx, wz) = flag(round.red_flag, bases[0]);
                        let (ex, ez) = flag(round.blue_flag, bases[1]);
                        for (index, &id) in
                            round.scores.keys().enumerate().filter(|(_, id)| online(id))
                        {
                            let [x, _, z, _, _] = players[&id].position;
                            message(
                                players,
                                id,
                                &format!(
                                    "map,{spawn},{},{},{wx},{wz},{ex},{ez},{},{}",
                                    x.round() as i32,
                                    z.round() as i32,
                                    index % 2,
                                    bases[index % 2]
                                ),
                            );
                        }
                        return true;
                    }
                    close_map(players, round);
                    None
                }
            };
            if let Some(winner) = result {
                notify(
                    players,
                    round,
                    &format!("{} won the challenge!", players[&winner].name),
                );
            } else {
                notify(players, round, "Challenge ended without a winner.");
            }
            close(round);
            false
        });
    }
}

fn close_map(players: &HashMap<u32, Player>, round: &Round) {
    for &id in round.scores.keys() {
        message(players, id, "map-off");
    }
}
