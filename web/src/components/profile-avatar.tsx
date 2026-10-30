import { UserRound } from "lucide-react"
import { Avatar, AvatarFallback, AvatarImage } from "@shared/ui/avatar"

export function ProfileAvatar({ src, size = 36, label = "Profile photo" }: { src?: string | null; size?: number; label?: string }) {
  return <Avatar style={{ width: size, height: size }}><AvatarImage src={src ?? undefined} alt={label} /><AvatarFallback aria-label="No profile photo"><UserRound className="size-1/2" aria-hidden="true" /></AvatarFallback></Avatar>
}
