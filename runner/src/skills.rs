//! Skills: folders with a SKILL.md (YAML frontmatter `name`, `description`) in ~/.gond-agent/skills and
//! .gond-agent/skills. The system prompt lists enabled skills; the `skill` tool loads one on demand.

use std::path::{Path, PathBuf};


#[derive(Debug, Clone)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub dir: PathBuf,
    pub enabled: bool,
}

fn frontmatter(text: &str) -> (Option<String>, Option<String>) {
    let mut name = None;
    let mut desc = None;
    let Some(rest) = text.strip_prefix("---") else { return (None, None) };
    let Some(end) = rest.find("\n---") else { return (None, None) };
    for line in rest[..end].lines() {
        if let Some((k, v)) = line.split_once(':') {
            let v = v.trim().trim_matches('"').trim_matches('\'').to_owned();
            match k.trim() {
                "name" => name = Some(v),
                "description" => desc = Some(v),
                _ => {}
            }
        }
    }
    (name, desc)
}

pub fn discover(cwd: &Path, disabled: &[String]) -> Vec<Skill> {
    let mut out: Vec<Skill> = vec![];
    for root in [crate::config::home().join("skills"), cwd.join(".gond-agent").join("skills")] {
        let Ok(rd) = std::fs::read_dir(&root) else { continue };
        let mut dirs: Vec<PathBuf> = rd.filter_map(Result::ok).map(|e| e.path()).filter(|p| p.join("SKILL.md").is_file()).collect();
        dirs.sort();
        for dir in dirs {
            let Ok(text) = std::fs::read_to_string(dir.join("SKILL.md")) else { continue };
            let (name, desc) = frontmatter(&text);
            let name = name.unwrap_or_else(|| dir.file_name().unwrap_or_default().to_string_lossy().into_owned());
            out.retain(|s| s.name != name); // project skills override global ones
            out.push(Skill { enabled: !disabled.contains(&name), name, description: desc.unwrap_or_default(), dir });
        }
    }
    out
}

pub fn prompt_section(skills: &[Skill]) -> String {
    let enabled: Vec<&Skill> = skills.iter().filter(|s| s.enabled).collect();
    if enabled.is_empty() {
        return String::new();
    }
    let mut s = String::from("\n\n# Skills\nLoad a skill with the skill tool when the task matches its description:\n");
    for sk in enabled {
        s.push_str(&format!("- {}: {}\n", sk.name, sk.description));
    }
    s
}

/// The skill tool's definition (handled by the agent core so toggles apply immediately).
pub fn tool_def() -> crate::api::wire::ToolDef {
    crate::api::wire::ToolDef {
        name: "skill".into(),
        description: "Load a skill's instructions (SKILL.md) by name. Files it mentions are relative to its folder.".into(),
        input_schema: crate::tools::schema(serde_json::json!({"name": {"type": "string"}}), &["name"]),
    }
}

/// Read an enabled skill's SKILL.md, prefixed with its folder.
pub fn load(skills: &[Skill], name: &str) -> Result<String, String> {
    let s = skills.iter().find(|s| s.name == name && s.enabled).ok_or_else(|| format!("no enabled skill named `{name}`"))?;
    let text = std::fs::read_to_string(s.dir.join("SKILL.md")).map_err(|e| format!("cannot read skill: {e}"))?;
    Ok(format!("Skill folder: {}\n\n{text}", s.dir.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_frontmatter() {
        let (n, d) = frontmatter("---\nname: deploy\ndescription: \"Ship the worker\"\n---\nbody");
        assert_eq!((n.as_deref(), d.as_deref()), (Some("deploy"), Some("Ship the worker")));
        assert_eq!(frontmatter("no frontmatter"), (None, None));
    }

    #[test]
    fn discovers_and_respects_disabled() {
        let dir = tempfile::tempdir().unwrap();
        let sk = dir.path().join(".gond-agent/skills/deploy");
        std::fs::create_dir_all(&sk).unwrap();
        std::fs::write(sk.join("SKILL.md"), "---\nname: deploy\ndescription: Ship it\n---\nSteps").unwrap();
        let found = discover(dir.path(), &[]);
        assert!(found.iter().any(|s| s.name == "deploy" && s.enabled));
        assert!(prompt_section(&found).contains("- deploy: Ship it"));
        let off = discover(dir.path(), &["deploy".into()]);
        assert!(off.iter().any(|s| s.name == "deploy" && !s.enabled));
    }
}
