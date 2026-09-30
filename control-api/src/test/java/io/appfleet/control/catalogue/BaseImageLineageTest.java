package io.appfleet.control.catalogue;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.test.context.ActiveProfiles;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest
@ActiveProfiles("test")
@Testcontainers
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
public class BaseImageLineageTest {

    @Container
    @ServiceConnection
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16" );

    @Autowired
    BaseImageRepository baseImageRepository;

    @Test
    void findLineage_returnsChainLeafFirst() {
        BaseImage root = baseImageRepository.save(new BaseImage("root-" + UUID.randomUUID(), "reg", null));
        BaseImage mid  = baseImageRepository.save(new BaseImage("mid-"  + UUID.randomUUID(), "reg", root));
        BaseImage leaf = baseImageRepository.save(new BaseImage("leaf-" + UUID.randomUUID(), "reg", mid));

        List<BaseImage> lineage = baseImageRepository.findLineage(leaf.getId());

        assertThat(lineage).extracting(BaseImage::getId)
                .containsExactly(leaf.getId(), mid.getId(), root.getId());
    }


    @Test
    void findLineage_ofRoot_isJustItself() {
        BaseImage root = baseImageRepository.save(new BaseImage("root-" + UUID.randomUUID(), "reg", null));

        assertThat(baseImageRepository.findLineage(root.getId()))
                .extracting(BaseImage::getId).containsExactly(root.getId());
    }

    @Test
    void findLineage_ofUnknownId_isEmpty() {
        assertThat(baseImageRepository.findLineage(UUID.randomUUID())).isEmpty();
    }

}
