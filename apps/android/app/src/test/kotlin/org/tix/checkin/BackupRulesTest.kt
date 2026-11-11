package org.tix.checkin

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element

/**
 * The database holds the Keystore-bound device token and the scan journal: nothing may be copied to a cloud
 * backup or another device (Android 12+: data extraction rules, older: full backup content), and allowBackup stays off.
 */
class BackupRulesTest {
    // Unit tests run with the module directory (apps/android/app) as working directory.
    private val main = File("src/main")
    private val domains = setOf("root", "file", "database", "sharedpref", "external", "device_root", "device_file")

    private fun parse(f: File): Element {
        assertTrue("missing ${f.path}", f.exists())
        return DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }.newDocumentBuilder().parse(f).documentElement
    }

    private fun excludes(section: Element): Set<String> {
        val out = HashSet<String>()
        val nodes = section.getElementsByTagName("exclude")
        for (i in 0 until nodes.length) {
            val e = nodes.item(i) as Element
            assertEquals("whole domain", ".", e.getAttribute("path"))
            out += e.getAttribute("domain")
        }
        // No include may re-admit anything.
        assertEquals(0, section.getElementsByTagName("include").length)
        return out
    }

    @Test
    fun `data extraction rules exclude every domain from cloud backup and device transfer`() {
        val root = parse(File(main, "res/xml/data_extraction_rules.xml"))
        for (name in listOf("cloud-backup", "device-transfer")) {
            val sections = root.getElementsByTagName(name)
            assertEquals("one $name section", 1, sections.length)
            assertEquals(name, domains, excludes(sections.item(0) as Element))
        }
    }

    @Test
    fun `full backup content excludes every domain`() {
        assertEquals(domains, excludes(parse(File(main, "res/xml/backup_rules.xml"))))
    }

    @Test
    fun `manifest points at both rule files and keeps allowBackup off`() {
        val app = parse(File(main, "AndroidManifest.xml")).getElementsByTagName("application").item(0) as Element
        val ns = "http://schemas.android.com/apk/res/android"
        assertEquals("false", app.getAttributeNS(ns, "allowBackup"))
        assertEquals("@xml/data_extraction_rules", app.getAttributeNS(ns, "dataExtractionRules"))
        assertEquals("@xml/backup_rules", app.getAttributeNS(ns, "fullBackupContent"))
    }
}
