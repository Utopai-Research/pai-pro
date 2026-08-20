/**
 * One demo per catalogue entry. Each is self-contained and mocks its own
 * state — nothing here touches the viewer, a socket, or the mutator.
 */
import { useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { UndoToast } from '../CanvasPage/UndoToast'

export function ButtonDemo(): JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button>Default</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="destructive">Destructive</Button>
        <Button variant="link">Link</Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm">Small</Button>
        <Button size="default">Default</Button>
        <Button size="lg">Large</Button>
        <Button disabled>Disabled</Button>
      </div>
    </div>
  )
}

export function BadgeDemo(): JSX.Element {
  return (
    <div className="flex flex-wrap gap-2">
      <Badge>default</Badge>
      <Badge variant="secondary">running</Badge>
      <Badge variant="destructive">failed</Badge>
      <Badge variant="outline">queued</Badge>
    </div>
  )
}

export function CardDemo(): JSX.Element {
  return (
    <Card className="max-w-sm">
      <CardHeader>
        <CardTitle>Project settings</CardTitle>
        <CardDescription>A panel container with header and body.</CardDescription>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        Card content sits here.
      </CardContent>
    </Card>
  )
}

export function InputDemo(): JSX.Element {
  return (
    <div className="flex max-w-sm flex-col gap-1.5">
      <Label htmlFor="demo-title">Project title</Label>
      <Input id="demo-title" placeholder="Untitled project" />
    </div>
  )
}

export function LabelDemo(): JSX.Element {
  return (
    <div className="flex max-w-sm flex-col gap-1.5">
      <Label htmlFor="demo-label-input">Prompt</Label>
      <Input id="demo-label-input" placeholder="Clicking the label focuses me" />
    </div>
  )
}

export function SelectDemo(): JSX.Element {
  return (
    <div className="flex max-w-sm flex-col gap-1.5">
      <Label>Image quality</Label>
      <Select defaultValue="2k">
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1k">Standard 1K</SelectItem>
          <SelectItem value="2k">Standard 2K</SelectItem>
          <SelectItem value="pro">Pro 2K</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}

export function SwitchDemo(): JSX.Element {
  const [on, setOn] = useState(false)
  return (
    <div className="flex max-w-sm items-center justify-between">
      <Label htmlFor="demo-switch">Run immediately</Label>
      <Switch id="demo-switch" checked={on} onCheckedChange={setOn} />
    </div>
  )
}

export function SeparatorDemo(): JSX.Element {
  return (
    <div className="flex max-w-sm flex-col gap-2 text-sm text-muted-foreground">
      <span>Above the line</span>
      <Separator />
      <span>Below the line</span>
    </div>
  )
}

export function TabsDemo(): JSX.Element {
  return (
    <Tabs defaultValue="general" className="max-w-sm">
      <TabsList>
        <TabsTrigger value="general">General</TabsTrigger>
        <TabsTrigger value="video">Video</TabsTrigger>
      </TabsList>
      <TabsContent value="general" className="pt-3 text-sm text-muted-foreground">
        General panel content
      </TabsContent>
      <TabsContent value="video" className="pt-3 text-sm text-muted-foreground">
        Video panel content
      </TabsContent>
    </Tabs>
  )
}

export function DialogDemo(): JSX.Element {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">Open dialog</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Dialog title</DialogTitle>
          <DialogDescription>
            Portalled to document.body, so it renders on the app tokens no
            matter which surface the trigger sits in.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary">Cancel</Button>
          <Button>Confirm</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function AlertDialogDemo(): JSX.Element {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline">Archive node</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive this node?</AlertDialogTitle>
          <AlertDialogDescription>
            Soft delete — it leaves the canvas but the asset stays on disk.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep</AlertDialogCancel>
          <AlertDialogAction>Archive</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function DropdownMenuDemo(): JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">Node actions</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>image_3</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem>
          Expand<DropdownMenuShortcut>⏎</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem>Refer in chat</DropdownMenuItem>
        <DropdownMenuItem>Download</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-destructive">Archive</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function PopoverDemo(): JSX.Element {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline">Open popover</Button>
      </PopoverTrigger>
      <PopoverContent className="text-sm text-muted-foreground">
        Anchored to its trigger, portalled like the rest.
      </PopoverContent>
    </Popover>
  )
}

export function TooltipDemo(): JSX.Element {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost">Hover me</Button>
        </TooltipTrigger>
        <TooltipContent>Tooltip content</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export function UndoToastDemo(): JSX.Element {
  // Remounting on each run replays the enter animation; the toast owns its
  // own 8s dismissal timer.
  const [run, setRun] = useState(0)
  const [visible, setVisible] = useState(true)
  return (
    <div className="relative h-40 overflow-hidden rounded-lg border border-[var(--line-1)] bg-[var(--bg-0)]">
      <div className="p-3">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setVisible(true)
            setRun((n) => n + 1)
          }}
        >
          Replay toast
        </Button>
      </div>
      {visible ? (
        <UndoToast
          key={run}
          message="Archived image_2"
          onUndo={() => setVisible(false)}
          onDismiss={() => setVisible(false)}
        />
      ) : null}
    </div>
  )
}
